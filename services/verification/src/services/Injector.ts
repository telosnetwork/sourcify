import Web3 from 'web3';
import * as bunyan from 'bunyan';
import { Match, InputData, getSupportedChains, getFullnodeChains, Logger, IFileService, FileService, StringMap, cborDecode, CheckedContract, MatchQuality, Chain, CompareResult, Status } from '@ethereum-sourcify/core';
import { RecompilationResult, getBytecode, recompile, getBytecodeWithoutMetadata as trimMetadata, checkEndpoint, getCreationDataFromArchive, getCreationDataByScraping, getCreationDataFromGraphQL } from '../utils';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const multihashes: any = require('multihashes');

export interface InjectorConfig {
    alchemyPID?: string,
    silent?: boolean,
    log?: bunyan,
    offline?: boolean,
    repositoryPath?: string,
    fileService?: IFileService
}

class InjectorChain {
    web3: Web3;
    rpc: string[];
    name: string;
    contractFetchAddress: string;
    graphQLFetchAddress: string;
    txRegex: string;
    archiveWeb3: Web3;

    constructor(chain: Chain) {
        this.rpc = chain.rpc;
        this.name = chain.name;
        this.contractFetchAddress = chain.contractFetchAddress;
        this.graphQLFetchAddress = chain.graphQLFetchAddress;
        this.txRegex = chain.txRegex;
        this.archiveWeb3 = chain.archiveWeb3;
    }
}

interface InjectorChainMap {
    [id: string]: InjectorChain
}

class LoggerWrapper {
    logger: bunyan;
    logId: string;

    constructor(logger: bunyan) {
        this.logger = logger;
        this.logId = Math.random().toString().slice(2);
    }

    info(obj: any, ...params: any[]): void {
        return this.logger.info(Object.assign(obj, { verificationId: this.logId }), ...params);
    }

    error(obj: any, ...params: any[]): void {
        return this.logger.error(Object.assign(obj, { verificationId: this.logId }), ...params);
    }
}

export class Injector {
    private log: bunyan;
    private chains: InjectorChainMap;
    private alchemyPID: string;
    private offline: boolean;
    public fileService: IFileService;
    repositoryPath: string;

    /**
     * Constructor
     * @param {InjectorConfig = {}} config
     */
    private constructor(config: InjectorConfig = {}) {
        this.chains = {};
        this.alchemyPID = config.alchemyPID;
        this.offline = config.offline || false;
        this.repositoryPath = config.repositoryPath;
        this.log = config.log || Logger("Injector");

        this.fileService = config.fileService || new FileService(this.repositoryPath, this.log);
    }

    /**
     * Creates an instance of Injector. Waits for chains to initialize.
     * Await this method to work with an instance that has all chains initialized.
     * @param config 
     */
    public static async createAsync(config: InjectorConfig = {}): Promise<Injector> {
        const instance = new Injector(config);
        if (!instance.offline) {
            await instance.initChains();
        }
        return instance;
    }

    /**
     * Creates an instance of Injector. Does not initialize chains.
     * @param config 
     */
    public static createOffline(config: InjectorConfig = {}): Injector {
        return new Injector(config);
    }

    /**
     * Instantiates a web3 provider for all public ethereum networks via Infura/Alchemy or regular node.
     * If environment variable TESTING is set to true, localhost:8545 is also available.
     */
    private async initChains() {
        if (this.alchemyPID) {
            this.log.info({loc: "[INIT_CHAINS]"}, "started checking providerPID");
            await checkEndpoint(this.alchemyPID).catch((err) => {
                this.log.warn({ providerID: this.alchemyPID }, err.message);
            })
            this.log.info({loc: "[INIT_CHAINS]"}, "finished checking providerPID");
        }

        const chainsData = this.alchemyPID ? getSupportedChains() : getFullnodeChains();

        for (const chain of chainsData) {
            this.chains[chain.chainId] = new InjectorChain(chain);

            if (this.alchemyPID) {
                const web3 = chain.rpc[0];
                this.chains[chain.chainId].web3 = new Web3(web3);
            } else {
                const web3 = chain.fullnode.dappnode;
                this.chains[chain.chainId].web3 = new Web3(web3)
                await checkEndpoint(web3).catch(() => {
                    this.log.warn({ endpoint: web3 }, `Invalid endpoint for chain ${chain.name}`);
                })
            }
        }

        const numberOfChains = Object.keys(this.chains).length;
        this.log.info({loc: "[INIT_CHAINS]", numberOfChains}, "Finished loading chains");
    }

    /**
     * Searches a set of addresses for the one whose deployedBytecode
     * matches a given bytecode string
     * @param {String[]}          addresses
     * @param {string}      deployedBytecode
     */
    private async matchBytecodeToAddress(
        chain: string,
        addresses: string[] = [],
        compiledRuntimeBytecode: string,
        compiledCreationBytecode: string,
    ): Promise<Match> {
        let match: Match = { address: null, status: null };
        const chainName = this.chains[chain].name || "The chain";

        for (let address of addresses) {
            address = Web3.utils.toChecksumAddress(address)

            let deployedBytecode: string | null = null;
            try {
                this.log.info(
                    {
                        loc: '[MATCH]',
                        chain: chain,
                        address: address
                    },
                    `Retrieving contract bytecode address`
                );
                deployedBytecode = await getBytecode(this.chains[chain].web3, address);
            } catch (e) { /* ignore */ }

            let compareResult;
            try {
                compareResult = await this.compareBytecodes(
                    deployedBytecode, null, compiledRuntimeBytecode, compiledCreationBytecode, chain, address
                );
            } catch (err) {
                if (addresses.length === 1) {
                    match.message = "There were problems during contract verification. Please try again in a minute.";
                }
            }

            if (compareResult && compareResult.status) {
                match = { address, status: compareResult.status, encodedConstructorArgs: compareResult.encodedConstructorArgs };
                break;
            } else if (addresses.length === 1 && !match.message) {
                if (!deployedBytecode) {
                    match.message = `${chainName} is temporarily unavailable.`
                } else if (deployedBytecode === "0x") {
                    match.message = `${chainName} does not have a contract deployed at ${address}.`;
                } else {
                    match.message = "The deployed and recompiled bytecode don't match.";
                }
            }
        }

        return match;
    }

    /**
     * Returns a string description of how closely two bytecodes match. Bytecodes
     * that match in all respects apart from their metadata hashes are 'partial'.
     * Bytecodes that don't match are `null`.
     * @param  {string} deployedBytecode
     * @param  {string} creationData
     * @param  {string} compiledRuntimeBytecode
     * @param  {string} compiledCreationBytecode
     * @param  {string} chain chainId of the chain where contract is being checked
     * @param  {string} address contract address
     * @return {CompareResult}  match description ('perfect'|'partial'|null) and possibly constructor args (ABI-encoded)
     */
    private async compareBytecodes(
        deployedBytecode: string | null,
        creationData: string,
        compiledRuntimeBytecode: string,
        compiledCreationBytecode: string,
        chain: string,
        address: string
    ): Promise<CompareResult> {

        if (deployedBytecode && deployedBytecode.length > 2) {
            if (deployedBytecode === compiledRuntimeBytecode) {
                return { status: "perfect", encodedConstructorArgs: undefined };
            }

            const trimmedDeployedBytecode = trimMetadata(deployedBytecode);
            const trimmedCompiledRuntimeBytecode = trimMetadata(compiledRuntimeBytecode);
            if (trimmedDeployedBytecode === trimmedCompiledRuntimeBytecode) {
                return { status: "partial", encodedConstructorArgs: undefined };
            }

            if (trimmedDeployedBytecode.length === trimmedCompiledRuntimeBytecode.length) {
                creationData = creationData || await this.getCreationData(chain, address);
                if (creationData) {
                    if (creationData.startsWith(compiledCreationBytecode)) {
                        // The reason why this uses `startsWith` instead of `===` is that
                        // creationData may contain constructor arguments at the end part.
                        const encodedConstructorArgs = this.extractEncodedConstructorArgs(creationData, compiledCreationBytecode);
                        return { status: "perfect", encodedConstructorArgs };
                    }

                    const trimmedCompiledCreationBytecode = trimMetadata(compiledCreationBytecode);

                    if (creationData.startsWith(trimmedCompiledCreationBytecode)) {
                        return { status: "partial", encodedConstructorArgs: undefined };
                    }
                }
            }
        }

        return { status: null, encodedConstructorArgs: undefined };
    }

    /**
     * Returns the `creationData` from the transaction that created the contract at the provided chain and address.
     * @param chain 
     * @param contractAddress 
     * @returns `creationData` if found, `null` otherwise
     */
    private async getCreationData(chain: string, contractAddress: string): Promise<string> {
        const loc = "[GET_CREATION_DATA]";
        let txFetchAddress = this.chains[chain].contractFetchAddress;
        const txRegex = this.chains[chain].txRegex;

        if (txFetchAddress && txRegex) { // fetch from a block explorer and extract by regex
            txFetchAddress = txFetchAddress.replace("${ADDRESS}", contractAddress);
            const web3 = this.chains[chain].web3;
            this.log.info({ loc, chain, contractAddress, fetchAddress: txFetchAddress }, "Scraping block explorer");
            try {
                return await getCreationDataByScraping(txFetchAddress, txRegex, web3);
            } catch(err) {
                this.log.error({ loc, chain, contractAddress, err: err.message }, "Scraping failed!");
            }
        }

        const graphQLFetchAddress = this.chains[chain].graphQLFetchAddress;
        if (graphQLFetchAddress) { // fetch from graphql node
            const web3 = this.chains[chain].web3;
            try {
                return await getCreationDataFromGraphQL(graphQLFetchAddress, contractAddress, web3);
            } catch (err) {
                this.log.error({ loc, chain, contractAddress, err: err.message });
            }
        }

        const archiveWeb3 = this.chains[chain].archiveWeb3;
        if (archiveWeb3) { // fetch by binary search on chain history
            this.log.info({ loc, chain, contractAddress }, "Fetching archive data");
            try {
                return await getCreationDataFromArchive(contractAddress, archiveWeb3);
            } catch(err) {
                this.log.error({ loc, chain, contractAddress, err: err.message }, "Archive search failed!");
            }
        }

        const err = "Cannot fetch creation data";
        this.log.error({ loc, chain, contractAddress, err });
        throw new Error(err);
    }

    private extractEncodedConstructorArgs(creationData: string, compiledCreationBytecode: string) {
        const startIndex = creationData.indexOf(compiledCreationBytecode);
        return "0x" + creationData.slice(startIndex + compiledCreationBytecode.length);
    }

    /**
     * Throws if addresses array contains a null value (express) or is length 0
     * @param {string[] = []} addresses param (submitted to injector)
     */
    private validateAddresses(addresses: string[] = []) {
        const err = new Error("Missing address for submitted sources/metadata");

        if (!addresses.length) {
            throw err;
        }

        for (const address of addresses) {
            if (address == null) throw err;
        }
    }

    /**
     * Throws if `chain` is falsy or wrong type
     * @param {string} chain param (submitted to injector)
     */
    private validateChain(chain: string) {
        if (!chain || typeof chain !== 'string') {
            throw new Error("Missing chain name for submitted sources/metadata");
        }
    }

    /**
     * Used by the front-end. Accepts a set of source files and a metadata string,
     * recompiles / validates them and stores them in the repository by chain/address
     * and by swarm | ipfs hash.
     * @param  {string}            repository repository root (ex: 'repository')
     * @param  {string}            chain      chain name (ex: 'ropsten')
     * @param  {string}            address    contract address
     * @param  {string[]}          files
     * @return {Promise<object>}              address & status of successfully verified contract
     */
    public async inject(inputData: InputData): Promise<Match> {
        const { chain, addresses, contract } = inputData;
        this.validateAddresses(addresses);
        this.validateChain(chain);

        let match: Match;
        const wrappedLogger = new LoggerWrapper(this.log);

        if (!CheckedContract.isValid(contract)) {
            await CheckedContract.fetchMissing(contract, wrappedLogger);
        }

        const compilationResult = await recompile(contract.metadata, contract.solidity, wrappedLogger);

        // When injector is called by monitor, the bytecode has already been
        // obtained for address and we only need to compare w/ compilation result.
        if (inputData.bytecode) {
            if (addresses.length !== 1) {
                const err = "Injector cannot work with multiple addresses if bytecode is provided";
                this.log.error({ loc: "[INJECTOR]", addresses, err });
                throw new Error(err);
            }
            const address = addresses[0];

            const compareResult = await this.compareBytecodes(
                inputData.bytecode,
                inputData.creationData,
                compilationResult.deployedBytecode,
                compilationResult.bytecode,
                chain,
                address
            );
            const checkedAddress = Web3.utils.toChecksumAddress(address);
            match = { address: checkedAddress, status: compareResult.status, encodedConstructorArgs: compareResult.encodedConstructorArgs };

        // For other cases, we need to retrieve the code for specified address
        // from the chain.
        } else {
            match = await this.matchBytecodeToAddress(
                chain,
                addresses,
                compilationResult.deployedBytecode,
                compilationResult.bytecode
            );
        }

        // Since the bytecode matches, we can be sure that we got the right
        // metadata file (up to json formatting) and exactly the right sources.
        // Now we can store the re-compiled and correctly formatted metadata file
        // and the sources.
        if (match.address && match.status) {
            const metadataPath = this.getMetadataPathFromCborEncoded(compilationResult, match.address, chain);
            if (metadataPath) {
                this.fileService.save(metadataPath, compilationResult.metadata);
                this.fileService.deletePartial(chain, match.address);
            } else {
                match.status = "partial";
            }

            const matchQuality = this.statusToMatchQuality(match.status);
            this.storeSources(matchQuality, chain, match.address, contract.solidity);
            this.storeMetadata(matchQuality, chain, match.address, compilationResult);

            if (match.encodedConstructorArgs && match.encodedConstructorArgs.length) {
                this.storeConstructorArgs(matchQuality, chain, match.address, match.encodedConstructorArgs);
            }

        } else {
            const message = match.message || "Could not match the deployed and recompiled bytecode."
            const err = new Error(`Contract name: ${contract.name}. ${message}`);

            this.log.error({
                loc: '[INJECT]', chain, addresses, err
            });

            throw new Error(err.message);
        }

        return match;
    }

    /**
     * This method exists because many different people have contributed to this code, which has led to the
     * lack of unanimous nomenclature
     * @param status 
     * @returns {MatchQuality} matchQuality
     */
    private statusToMatchQuality(status: Status): MatchQuality {
        if (status === "perfect") return "full";
        if (status === "partial") return status;
    }

    private sanitizePath(originalPath: string): string {
        return originalPath
            .replace(/[^a-z0-9_./-]/gim, "_")
            .replace(/(^|\/)[.]+($|\/)/, '_');
    }

    private getMetadataPathFromCborEncoded(compilationResult: RecompilationResult, address: string, chain: string) {
        const bytes = Web3.utils.hexToBytes(compilationResult.deployedBytecode);
        const cborData = cborDecode(bytes);

        if (cborData['bzzr0']) {
            return`/swarm/bzzr0/${Web3.utils.bytesToHex(cborData['bzzr0']).slice(2)}`;
        } else if (cborData['bzzr1']) {
            return `/swarm/bzzr1/${Web3.utils.bytesToHex(cborData['bzzr1']).slice(2)}`;
        } else if (cborData['ipfs']) {
            return `/ipfs/${multihashes.toB58String(cborData['ipfs'])}`;
        }

        this.log.error({
            loc: '[INJECTOR:GET_METADATA_PATH]',
            address,
            chain,
            err: "No metadata hash in cbor encoded data."
        });
        return null;
    }

    /**
     * Stores the metadata from compilationResult to the swarm | ipfs subrepo. The exact storage path depends
     * on the swarm | ipfs address extracted from compilationResult.deployedByteode.
     * 
     * @param chain used only for logging
     * @param address used only for loggin
     * @param compilationResult should contain deployedBytecode and metadata
     */
    private storeMetadata(matchQuality: MatchQuality, chain: string, address: string, compilationResult: RecompilationResult) {
        this.fileService.save({
            matchQuality,
            chain,
            address,
            fileName: "metadata.json"
        },
            compilationResult.metadata
        );
    }

    /**
     * Writes the verified sources (.sol files) to the repository.
     * @param {string}              chain             chain name (ex: 'ropsten')
     * @param {string}              address           contract address
     * @param {StringMap}           sources           'rearranged' sources
     * @param {MatchQuality}        matchQuality
     */
    private storeSources(matchQuality: MatchQuality, chain: string, address: string, sources: StringMap) {
        for (const sourcePath in sources) {
            this.fileService.save({
                matchQuality,
                chain,
                address,
                source: true,
                fileName: this.sanitizePath(sourcePath)
            },
                sources[sourcePath]
            );
        }
    }

    /**
     * Writes the constructor arguments to the repository.
     * @param matchQuality 
     * @param chain 
     * @param address 
     * @param encodedConstructorArgs 
     * @param metadataRaw 
     */
    private storeConstructorArgs(matchQuality: MatchQuality, chain: string, address: string, encodedConstructorArgs: string) {
        this.fileService.save({
            matchQuality,
            chain,
            address,
            source: false,
            fileName: "constructor-args.txt"
        },
            encodedConstructorArgs
        )
    }
}

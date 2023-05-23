const { deployFromPrivateKey } = require("../helpers/helpers");
const Web3 = require("web3");
const StorageArtifact = require("./sources/shared/1_Storage.json");
const { supportedChainsArray } = require("../../dist/sourcify-chains");
const { program } = require("commander");

program
  .description(
    "Script to deploy Sourcify's (sourcify.dev) sample contracts (both with immutables and without)"
  )
  .helpOption("-h, --help", "Output the help message.")
  .usage("--chainId=<chainId> --privateKey=<privateKey>")
  .requiredOption(
    "--chainId <chainId>",
    "Chain ID of the chain to deploy the contract. The chain must be added to src/sourcify-chains.ts. Also make sure to build typescript after adding the chain with `npx lerna run build`."
  )
  .requiredOption(
    "--privateKey <privateKey>",
    "Private key of the account that will deploy the contract"
  )
  .option(
    "--immutableValue <uint256>",
    "Value to be stored as the immutable value. "
  )
  .showSuggestionAfterError()
  .showHelpAfterError("(add --help for additional information)");

program.parse();
const options = program.opts();

if (require.main === module) {
  main(options.chainId, options.privateKey);
}

async function main(chainId, privateKey) {
  const chains = supportedChainsArray;
  const chain = chains.find((chain) => chain.chainId == chainId);
  if (!chain) {
    console.error(
      `Chain config for chainId "${chainId}" not found in list of supported chains, abort.`
    );
    return;
  }
  let web3;
  console.log("Using rpc: " + chain.rpc[0]);
  try {
    web3 = new Web3(chain.rpc[0]);
  } catch (err) {
    console.log(
      `Can't initiate a Web3 instance with the chain: ${chain}. \n\nMake sure the chainId is added to src/sourcify-chains.ts and built with npx lerna run build`
    );
    throw new Error(err);
  }

  console.log("Deploying the contract...");
  const contractAddress2 = await deployFromPrivateKey(
    web3,
    StorageArtifact.abi,
    StorageArtifact.bytecode,
    privateKey,
    []
  );
  console.log(
    `Contract deployed at ${contractAddress2} on the chain ${chain.name} (${chain.chainId})`
  );
}

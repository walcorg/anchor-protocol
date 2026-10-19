const hre = require("hardhat");

// Required environment variables:
//   BASE_URI      e.g. "ipfs://<CID_RAIZ>/"   (immutable after deploy, must end with "/")
//   SHIELD_PUB_X  0x... 32 bytes  X of the acquisition shield TROPIC01 anchor key (P-256)
//   SHIELD_PUB_Y  0x... 32 bytes  Y of the same key
//   CIWI_PUB_X    0x... 32 bytes  X of the CiWi TROPIC01 anchor key (P-256)
//   CIWI_PUB_Y    0x... 32 bytes  Y of the same key
//   FW_HASH       0x... 32 bytes  hash of the acquisition firmware build
//   OWNER         CiWi Polygon address: sends the mints and receives the 100 NFTs
async function main() {
  const env = process.env;
  const keys = ["BASE_URI", "SHIELD_PUB_X", "SHIELD_PUB_Y", "CIWI_PUB_X", "CIWI_PUB_Y", "FW_HASH", "OWNER"];
  for (const k of keys) if (!env[k]) throw new Error(`Missing env var ${k}`);
  if (!env.BASE_URI.endsWith("/")) throw new Error("BASE_URI must end with '/'");

  const F = await hre.ethers.getContractFactory("BioentropyGenesis");
  const c = await F.deploy(
    env.BASE_URI, env.SHIELD_PUB_X, env.SHIELD_PUB_Y, env.CIWI_PUB_X, env.CIWI_PUB_Y, env.FW_HASH, env.OWNER
  );
  await c.waitForDeployment();

  console.log("BioentropyGenesis v7 deployed to:", await c.getAddress());
  console.log("shieldId:", await c.shieldId());
  console.log("ciwiId:  ", await c.ciwiId());
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

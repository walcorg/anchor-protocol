const { expect } = require("chai");
const { ethers } = require("hardhat");
const { p256 } = require("@noble/curves/p256");

// Two simulated TROPIC01 chips: the acquisition shield and the CiWi.
function makeKey() {
  const priv = p256.utils.randomPrivateKey();
  const pub = p256.getPublicKey(priv, false); // 0x04 || X || Y
  return { priv, x: ethers.hexlify(pub.slice(1, 33)), y: ethers.hexlify(pub.slice(33, 65)) };
}
const SHIELD = makeKey();
const CIWI = makeKey();
const FW_HASH = ethers.keccak256(ethers.toUtf8Bytes("clorela-os-acq-fw-1.0.0"));
const BASE_URI = "ipfs://bafyTESTCID/";
const idOf = (k) => ethers.keccak256(ethers.solidityPacked(["uint8", "bytes32", "bytes32"], [1, k.x, k.y]));

function sign(digestHex, priv) {
  const sig = p256.sign(ethers.getBytes(digestHex), priv, { lowS: true, prehash: false });
  return { r: ethers.toBeHex(sig.r, 32), s: ethers.toBeHex(sig.s, 32) };
}

const WINDOW_TYPES = {
  WindowRecord: [
    { name: "version", type: "uint8" }, { name: "curve", type: "uint8" },
    { name: "shieldId", type: "bytes32" }, { name: "fwHash", type: "bytes32" },
    { name: "tokenId", type: "uint16" }, { name: "windowStart", type: "uint64" },
    { name: "windowEnd", type: "uint64" }, { name: "challengeBlock", type: "uint64" },
    { name: "challenge", type: "bytes32" }, { name: "responseHash", type: "bytes32" },
    { name: "dataRoot", type: "bytes32" }, { name: "nonce", type: "bytes16" },
  ],
};
const CLAIM_TYPES = {
  NftClaim: [
    { name: "recordHash", type: "bytes32" }, { name: "metadataHash", type: "bytes32" },
    { name: "ciwiId", type: "bytes32" },
    { name: "owner", type: "address" },
  ],
};

describe("BioentropyGenesis v7 (Anchor Protocol v0.2, NFT profile)", function () {
  let contract, owner, other, domain;

  async function makeRecord(tokenId, startOffset = 0) {
    const blk = await ethers.provider.getBlock("latest");
    const windowStart = blk.timestamp - 3600 + startOffset;
    return {
      version: 2, curve: 1, tokenId,
      windowStart, windowEnd: windowStart + 1200,
      challengeBlock: blk.number, challenge: blk.hash,
      responseHash: ethers.keccak256(ethers.toUtf8Bytes(`optical-response-${tokenId}`)),
      dataRoot: ethers.keccak256(ethers.toUtf8Bytes(`dataset-${tokenId}`)),
      nonce: ethers.hexlify(ethers.randomBytes(16)),
    };
  }

  const metaOf = (id) => ethers.keccak256(ethers.toUtf8Bytes(`${id}.json`));

  // Shield signs at window end; CiWi signs record + final metadata hash after the button press.
  async function approval(rec, shieldPriv = SHIELD.priv, ciwiPriv = CIWI.priv, metadataHash = metaOf(rec.tokenId)) {
    return {
      metadataHash,
      shieldSig: sign(await contract.recordDigest(rec), shieldPriv),
      ciwiSig: sign(await contract.claimDigest(rec, metadataHash), ciwiPriv),
    };
  }

  beforeEach(async function () {
    [owner, other] = await ethers.getSigners();
    const F = await ethers.getContractFactory("BioentropyGenesis");
    contract = await F.deploy(BASE_URI, SHIELD.x, SHIELD.y, CIWI.x, CIWI.y, FW_HASH, owner.address);
    await contract.waitForDeployment();
    await ethers.provider.send("evm_mine", []);
    const net = await ethers.provider.getNetwork();
    domain = { name: "WALCORG Anchor", version: "0.2", chainId: net.chainId, verifyingContract: await contract.getAddress() };
  });

  it("deploys with the shield and CiWi identities of the protocol", async function () {
    expect(await contract.name()).to.equal("Bioentropy Genesis");
    expect(await contract.shieldId()).to.equal(idOf(SHIELD));
    expect(await contract.ciwiId()).to.equal(idOf(CIWI));
    expect(await contract.PROTOCOL_VERSION()).to.equal(2);
  });

  it("conformance: off-chain EIP-712 digests equal the contract digests", async function () {
    const rec = await makeRecord(1);
    const recValue = { ...rec, shieldId: idOf(SHIELD), fwHash: FW_HASH };
    expect(ethers.TypedDataEncoder.hash(domain, WINDOW_TYPES, recValue)).to.equal(await contract.recordDigest(rec));

    const recordHash = ethers.TypedDataEncoder.hashStruct("WindowRecord", WINDOW_TYPES, recValue);
    const claimValue = { recordHash, metadataHash: metaOf(1), ciwiId: idOf(CIWI), owner: owner.address };
    expect(ethers.TypedDataEncoder.hash(domain, CLAIM_TYPES, claimValue)).to.equal(await contract.claimDigest(rec, metaOf(1)));
  });

  it("mints with both signatures and stores provenance", async function () {
    const rec = await makeRecord(1);
    const a = await approval(rec);
    await expect(contract.mintAnchored(rec, a)).to.emit(contract, "Anchored");
    expect(await contract.ownerOf(1)).to.equal(owner.address);
    expect(await contract.tokenURI(1)).to.equal(BASE_URI + "1.json");
    const stored = await contract.recordOf(1);
    expect(stored.responseHash).to.equal(rec.responseHash);
    expect(stored.dataRoot).to.equal(rec.dataRoot);
    expect(await contract.metadataHashOf(1)).to.equal(metaOf(1));
  });

  it("rejects a record signed by another shield (cloned or fake node)", async function () {
    const rec = await makeRecord(1);
    const a = await approval(rec, makeKey().priv);
    await expect(contract.mintAnchored(rec, a)).to.be.revertedWithCustomError(contract, "BadShieldSignature");
  });

  it("rejects a claim not signed by the registered CiWi", async function () {
    const rec = await makeRecord(1);
    const a = await approval(rec, SHIELD.priv, makeKey().priv);
    await expect(contract.mintAnchored(rec, a)).to.be.revertedWithCustomError(contract, "BadCiwiSignature");
  });

  it("rejects a mint without the CiWi signature (shield signature reused)", async function () {
    const rec = await makeRecord(1);
    const a = await approval(rec);
    await expect(contract.mintAnchored(rec, { ...a, ciwiSig: a.shieldSig })).to.be.revertedWithCustomError(contract, "BadCiwiSignature");
  });

  it("rejects a record altered after signing (e.g. different optical response)", async function () {
    const rec = await makeRecord(1);
    const a = await approval(rec);
    const tampered = { ...rec, responseHash: ethers.keccak256(ethers.toUtf8Bytes("fake response")) };
    await expect(contract.mintAnchored(tampered, a)).to.be.revertedWithCustomError(contract, "BadShieldSignature");
  });

  it("rejects metadata different from the one the CiWi approved", async function () {
    const rec = await makeRecord(1);
    const a = await approval(rec);
    const swapped = { ...a, metadataHash: ethers.keccak256(ethers.toUtf8Bytes("other.json")) };
    await expect(contract.mintAnchored(rec, swapped)).to.be.revertedWithCustomError(contract, "BadCiwiSignature");
  });

  it("rejects a high-s (malleated) signature", async function () {
    const rec = await makeRecord(1);
    const a = await approval(rec);
    const highS = { r: a.shieldSig.r, s: ethers.toBeHex(p256.CURVE.n - BigInt(a.shieldSig.s), 32) };
    await expect(contract.mintAnchored(rec, { ...a, shieldSig: highS })).to.be.revertedWithCustomError(contract, "BadShieldSignature");
  });

  it("rejects unsupported version or curve", async function () {
    const rec = { ...(await makeRecord(1)), version: 1 };
    let a = await approval(rec);
    await expect(contract.mintAnchored(rec, a)).to.be.revertedWithCustomError(contract, "UnsupportedVersion");
    const rec2 = { ...(await makeRecord(1)), curve: 2 };
    a = await approval(rec2);
    await expect(contract.mintAnchored(rec2, a)).to.be.revertedWithCustomError(contract, "UnsupportedCurve");
  });

  it("enforces sequential ids, non-overlapping windows and no replay", async function () {
    const r1 = await makeRecord(1);
    let a = await approval(r1);
    await contract.mintAnchored(r1, a);
    await expect(contract.mintAnchored(r1, a)).to.be.revertedWithCustomError(contract, "WrongTokenId");

    const skip = await makeRecord(3, 1200);
    a = await approval(skip);
    await expect(contract.mintAnchored(skip, a)).to.be.revertedWithCustomError(contract, "WrongTokenId");

    const overlap = await makeRecord(2, 600);
    a = await approval(overlap);
    await expect(contract.mintAnchored(overlap, a)).to.be.revertedWithCustomError(contract, "BadWindow");
  });

  it("rejects a challenge block from the future", async function () {
    const rec = await makeRecord(1);
    rec.challengeBlock = (await ethers.provider.getBlockNumber()) + 50;
    const a = await approval(rec);
    await expect(contract.mintAnchored(rec, a)).to.be.revertedWithCustomError(contract, "ChallengeFromFuture");
  });

  it("only the owner (CiWi address) can send the mint", async function () {
    const rec = await makeRecord(1);
    const a = await approval(rec);
    await expect(contract.connect(other).mintAnchored(rec, a))
      .to.be.revertedWithCustomError(contract, "OwnableUnauthorizedAccount");
  });

  it("mints all 100 in 4 batches and then stops", async function () {
    const blk = await ethers.provider.getBlock("latest");
    const base = blk.timestamp - 100 * 1200 - 60;
    for (let b = 0; b < 4; b++) {
      const recs = [], aps = [];
      for (let i = 1; i <= 25; i++) {
        const id = b * 25 + i;
        const rec = {
          version: 2, curve: 1, tokenId: id,
          windowStart: base + (id - 1) * 1200, windowEnd: base + id * 1200,
          challengeBlock: blk.number, challenge: blk.hash,
          responseHash: ethers.keccak256(ethers.toUtf8Bytes(`optical-response-${id}`)),
          dataRoot: ethers.keccak256(ethers.toUtf8Bytes(`dataset-${id}`)),
          nonce: ethers.hexlify(ethers.randomBytes(16)),
        };
        recs.push(rec); aps.push(await approval(rec));
      }
      await contract.mintAnchoredBatch(recs, aps);
    }
    expect(await contract.totalMinted()).to.equal(100);
    const extra = await makeRecord(101, 999999);
    const ax = await approval(extra);
    await expect(contract.mintAnchored(extra, ax)).to.be.revertedWithCustomError(contract, "SupplyExhausted");
  });

  it("has no price, withdraw or base-URI setter (immutable metadata)", async function () {
    for (const f of ["setBaseURI", "setMintPrice", "withdraw", "mint"]) {
      expect(contract.interface.getFunction(f)).to.equal(null);
    }
  });
});

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/P256.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

/// @title Bioentropy Genesis Collection — v7
/// @notice Implements the NFT profile of the WALCORG Anchor Protocol v0.2 (section 11).
///         100 generative-art NFTs; each token needs two P-256 signatures:
///           1. the shield's TROPIC01 over a WindowRecord (the 20-minute acquisition window), and
///           2. the CiWi's TROPIC01 over an NftClaim (record hash + metadata hash), produced after
///              the owner presses the button.
///         The shield attests the data at window end; the CiWi attests the final metadata later.
///         The owner transaction itself is sent from the CiWi address (secp256k1, by its MCU).
/// @dev    Tokens are pre-minted to the owner and sold on OpenSea. No public mint, no price,
///         no royalties, immutable metadata. Only one shield and one CiWi, fixed at deploy.
contract BioentropyGenesis is ERC721, Ownable, EIP712 {
    using Strings for uint256;

    uint256 public constant MAX_SUPPLY = 100;
    uint8 public constant PROTOCOL_VERSION = 2; // Anchor Protocol v0.2
    uint8 public constant CURVE_P256 = 1;       // 2 = secp256k1, reserved

    /// @notice Shield (data-acquisition node) TROPIC01 anchor key, P-256.
    bytes32 public immutable shieldPubX;
    bytes32 public immutable shieldPubY;
    bytes32 public immutable shieldId; // keccak256(curve || pubX || pubY)

    /// @notice CiWi TROPIC01 anchor key, P-256.
    bytes32 public immutable ciwiPubX;
    bytes32 public immutable ciwiPubY;
    bytes32 public immutable ciwiId;   // keccak256(curve || pubX || pubY)

    /// @notice Hash of the acquisition firmware allowed to produce records.
    bytes32 public immutable fwHash;

    /// @dev Fixed at deploy, e.g. "ipfs://<CID>/". No setter: metadata is immutable.
    string private _baseTokenURI;

    /// @notice One acquisition window per token. Signed by the shield.
    struct WindowRecord {
        uint8 version;         // must equal PROTOCOL_VERSION
        uint8 curve;           // must equal CURVE_P256
        uint16 tokenId;        // 1..100, minted in order
        uint64 windowStart;    // unix seconds
        uint64 windowEnd;      // unix seconds
        uint64 challengeBlock; // Polygon block whose hash seeded the optical challenge
        bytes32 challenge;     // blockhash(challengeBlock); verified off-chain
        bytes32 responseHash;  // hash of the optical-response transcript to the challenge
        bytes32 dataRoot;      // Merkle root (or hash) of the window's raw dataset
        bytes16 nonce;         // TROPIC01 TRNG; uniqueness only
    }

    bytes32 private constant WINDOW_TYPEHASH = keccak256(
        "WindowRecord(uint8 version,uint8 curve,bytes32 shieldId,bytes32 fwHash,uint16 tokenId,uint64 windowStart,uint64 windowEnd,uint64 challengeBlock,bytes32 challenge,bytes32 responseHash,bytes32 dataRoot,bytes16 nonce)"
    );
    /// @dev Signed by the CiWi after it verified the shield signature and the owner pressed the button.
    ///      metadataHash = keccak256 of the exact <tokenId>.json bytes (known only after the art is generated).
    bytes32 private constant NFT_CLAIM_TYPEHASH =
        keccak256("NftClaim(bytes32 recordHash,bytes32 metadataHash,bytes32 ciwiId,address owner)");

    uint256 public totalMinted;
    uint64 public lastWindowEnd;
    mapping(uint256 => WindowRecord) private _records;
    mapping(uint256 => bytes32) public metadataHashOf;

    event Anchored(
        uint256 indexed tokenId,
        bytes32 indexed dataRoot,
        bytes32 metadataHash,
        bytes32 responseHash,
        uint64 windowStart,
        uint64 windowEnd,
        uint64 challengeBlock,
        bytes32 challenge
    );

    error UnsupportedVersion();
    error UnsupportedCurve();
    error WrongTokenId(uint256 expected, uint256 got);
    error SupplyExhausted();
    error BadWindow();
    error ChallengeFromFuture();
    error BadShieldSignature();
    error BadCiwiSignature();
    error NoRecord();

    /// @param initialOwner address that sends the mint transactions and receives the NFTs (the CiWi address)
    constructor(
        string memory baseURI_,
        bytes32 shieldPubX_,
        bytes32 shieldPubY_,
        bytes32 ciwiPubX_,
        bytes32 ciwiPubY_,
        bytes32 fwHash_,
        address initialOwner
    )
        ERC721("Bioentropy Genesis", "BIOG")
        Ownable(initialOwner)
        EIP712("WALCORG Anchor", "0.2")
    {
        _baseTokenURI = baseURI_;
        shieldPubX = shieldPubX_;
        shieldPubY = shieldPubY_;
        shieldId = keccak256(abi.encodePacked(CURVE_P256, shieldPubX_, shieldPubY_));
        ciwiPubX = ciwiPubX_;
        ciwiPubY = ciwiPubY_;
        ciwiId = keccak256(abi.encodePacked(CURVE_P256, ciwiPubX_, ciwiPubY_));
        fwHash = fwHash_;
    }

    // ------------------------------------------------------------------ mint

    struct Sig {
        bytes32 r;
        bytes32 s;
    }

    /// @notice What the CiWi approves for one token.
    struct MintApproval {
        bytes32 metadataHash;
        Sig shieldSig; // over recordDigest(rec)
        Sig ciwiSig;   // over claimDigest(rec, metadataHash)
    }

    /// @notice Mint the next token. Both signatures must have low s (s <= n/2).
    function mintAnchored(WindowRecord calldata rec, MintApproval calldata a) external onlyOwner {
        _mintAnchored(rec, a);
    }

    /// @notice Batch version (e.g. 4 transactions of 25 tokens).
    function mintAnchoredBatch(WindowRecord[] calldata recs, MintApproval[] calldata approvals) external onlyOwner {
        require(recs.length == approvals.length, "length mismatch");
        for (uint256 i = 0; i < recs.length; i++) {
            _mintAnchored(recs[i], approvals[i]);
        }
    }

    function _mintAnchored(WindowRecord calldata rec, MintApproval calldata a) internal {
        // cheap checks first (protocol section 6 order)
        if (rec.version != PROTOCOL_VERSION) revert UnsupportedVersion();
        if (rec.curve != CURVE_P256) revert UnsupportedCurve();
        if (totalMinted >= MAX_SUPPLY) revert SupplyExhausted();
        uint256 expected = totalMinted + 1;
        if (rec.tokenId != expected) revert WrongTokenId(expected, rec.tokenId);
        if (rec.windowEnd <= rec.windowStart || rec.windowStart < lastWindowEnd) revert BadWindow();
        if (rec.windowEnd > block.timestamp) revert BadWindow();
        if (rec.challengeBlock >= block.number) revert ChallengeFromFuture();

        bytes32 recordHash = _recordStructHash(rec);
        if (!P256.verify(_hashTypedDataV4(recordHash), a.shieldSig.r, a.shieldSig.s, shieldPubX, shieldPubY)) {
            revert BadShieldSignature();
        }
        if (!P256.verify(_claimDigest(recordHash, a.metadataHash), a.ciwiSig.r, a.ciwiSig.s, ciwiPubX, ciwiPubY)) {
            revert BadCiwiSignature();
        }

        _records[rec.tokenId] = rec;
        metadataHashOf[rec.tokenId] = a.metadataHash;
        totalMinted = expected;
        lastWindowEnd = rec.windowEnd;

        _mint(owner(), rec.tokenId);
        emit Anchored(
            rec.tokenId, rec.dataRoot, a.metadataHash, rec.responseHash,
            rec.windowStart, rec.windowEnd, rec.challengeBlock, rec.challenge
        );
    }

    // --------------------------------------------------------------- views

    /// @notice EIP-712 digest the shield's TROPIC01 signs.
    function recordDigest(WindowRecord calldata rec) external view returns (bytes32) {
        return _hashTypedDataV4(_recordStructHash(rec));
    }

    /// @notice EIP-712 digest the CiWi's TROPIC01 signs for this record and metadata (owner = current owner).
    function claimDigest(WindowRecord calldata rec, bytes32 metadataHash) external view returns (bytes32) {
        return _claimDigest(_recordStructHash(rec), metadataHash);
    }

    function recordOf(uint256 tokenId) external view returns (WindowRecord memory) {
        if (_records[tokenId].tokenId == 0) revert NoRecord();
        return _records[tokenId];
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        return string.concat(_baseTokenURI, tokenId.toString(), ".json");
    }

    // ------------------------------------------------------------ internal

    function _recordStructHash(WindowRecord calldata rec) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                WINDOW_TYPEHASH,
                rec.version,
                rec.curve,
                shieldId,
                fwHash,
                rec.tokenId,
                rec.windowStart,
                rec.windowEnd,
                rec.challengeBlock,
                rec.challenge,
                rec.responseHash,
                rec.dataRoot,
                rec.nonce
            )
        );
    }

    function _claimDigest(bytes32 recordHash, bytes32 metadataHash) internal view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(NFT_CLAIM_TYPEHASH, recordHash, metadataHash, ciwiId, owner()))
        );
    }
}

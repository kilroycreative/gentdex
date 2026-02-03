// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

interface IAIDRegistry {
    function aidOf(address owner) external view returns (uint256);
    function custodyOf(uint256 aid) external view returns (address);
}

/**
 * @title KeyRegistry
 * @notice Registry for signing keys associated with Agent IDs
 * @dev Keys are EdDSA public keys that can sign messages on behalf of an AID
 */
contract KeyRegistry is Ownable, Pausable {
    /*//////////////////////////////////////////////////////////////
                                 TYPES
    //////////////////////////////////////////////////////////////*/
    
    enum KeyState {
        NULL,       // Key does not exist
        ADDED,      // Key is active
        REMOVED     // Key was removed
    }
    
    enum KeyType {
        SIGNING,    // Can sign messages
        ENCRYPTION  // For encrypted communications (future)
    }
    
    struct KeyData {
        KeyState state;
        KeyType keyType;
        uint256 addedAt;
        uint256 removedAt;
    }
    
    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/
    
    error Unauthorized();           // Caller not authorized
    error InvalidKey();             // Key is invalid
    error KeyExists();              // Key already exists
    error KeyNotFound();            // Key does not exist
    error ExceedsMaxKeys();         // Too many keys
    
    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/
    
    /// @notice Emitted when a key is added
    event Add(
        uint256 indexed aid,
        bytes32 indexed keyHash,
        bytes key,
        KeyType keyType,
        address addedBy
    );
    
    /// @notice Emitted when a key is removed
    event Remove(
        uint256 indexed aid,
        bytes32 indexed keyHash,
        address removedBy
    );
    
    /*//////////////////////////////////////////////////////////////
                                 STORAGE
    //////////////////////////////////////////////////////////////*/
    
    /// @notice Reference to AID Registry
    IAIDRegistry public immutable aidRegistry;
    
    /// @notice Maximum keys per AID
    uint256 public maxKeysPerAid = 10;
    
    /// @notice Key data: AID => keyHash => KeyData
    mapping(uint256 => mapping(bytes32 => KeyData)) public keys;
    
    /// @notice Active key count per AID
    mapping(uint256 => uint256) public keyCount;
    
    /// @notice All key hashes for an AID (for enumeration)
    mapping(uint256 => bytes32[]) public keyHashes;
    
    /*//////////////////////////////////////////////////////////////
                               CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/
    
    constructor(
        address _owner,
        address _aidRegistry
    ) Ownable(_owner) {
        aidRegistry = IAIDRegistry(_aidRegistry);
    }
    
    /*//////////////////////////////////////////////////////////////
                            KEY MANAGEMENT
    //////////////////////////////////////////////////////////////*/
    
    /**
     * @notice Add a signing key for your AID
     * @param key The EdDSA public key (32 bytes)
     * @param keyType The type of key (SIGNING or ENCRYPTION)
     */
    function add(bytes calldata key, KeyType keyType) external whenNotPaused {
        uint256 aid = aidRegistry.aidOf(msg.sender);
        if (aid == 0) revert Unauthorized();
        
        _addKey(aid, key, keyType, msg.sender);
    }
    
    /**
     * @notice Add a key for another AID (requires custody signature)
     * @dev Used for apps to request keys on behalf of users
     */
    function addFor(
        uint256 aid,
        bytes calldata key,
        KeyType keyType,
        uint256 deadline,
        bytes calldata signature
    ) external whenNotPaused {
        // Verify signature from custody address
        address custody = aidRegistry.custodyOf(aid);
        bytes32 digest = keccak256(abi.encodePacked(
            "\x19Ethereum Signed Message:\n32",
            keccak256(abi.encodePacked(aid, key, keyType, deadline, address(this)))
        ));
        
        address signer = _recoverSigner(digest, signature);
        if (signer != custody) revert Unauthorized();
        if (block.timestamp > deadline) revert Unauthorized();
        
        _addKey(aid, key, keyType, msg.sender);
    }
    
    /**
     * @dev Internal key addition logic
     */
    function _addKey(
        uint256 aid,
        bytes calldata key,
        KeyType keyType,
        address addedBy
    ) internal {
        if (key.length != 32) revert InvalidKey();
        if (keyCount[aid] >= maxKeysPerAid) revert ExceedsMaxKeys();
        
        bytes32 keyHash = keccak256(key);
        KeyData storage keyData = keys[aid][keyHash];
        
        if (keyData.state == KeyState.ADDED) revert KeyExists();
        
        keyData.state = KeyState.ADDED;
        keyData.keyType = keyType;
        keyData.addedAt = block.timestamp;
        keyData.removedAt = 0;
        
        if (keys[aid][keyHash].addedAt == block.timestamp) {
            // New key, add to enumeration
            keyHashes[aid].push(keyHash);
        }
        
        keyCount[aid]++;
        
        emit Add(aid, keyHash, key, keyType, addedBy);
    }
    
    /**
     * @notice Remove a signing key
     * @param key The key to remove
     */
    function remove(bytes calldata key) external whenNotPaused {
        uint256 aid = aidRegistry.aidOf(msg.sender);
        if (aid == 0) revert Unauthorized();
        
        bytes32 keyHash = keccak256(key);
        KeyData storage keyData = keys[aid][keyHash];
        
        if (keyData.state != KeyState.ADDED) revert KeyNotFound();
        
        keyData.state = KeyState.REMOVED;
        keyData.removedAt = block.timestamp;
        keyCount[aid]--;
        
        emit Remove(aid, keyHash, msg.sender);
    }
    
    /*//////////////////////////////////////////////////////////////
                               VIEWS
    //////////////////////////////////////////////////////////////*/
    
    /**
     * @notice Get key state for an AID
     */
    function keyStateOf(uint256 aid, bytes calldata key) external view returns (KeyState) {
        return keys[aid][keccak256(key)].state;
    }
    
    /**
     * @notice Check if a key is valid for an AID
     */
    function isValidKey(uint256 aid, bytes calldata key) external view returns (bool) {
        return keys[aid][keccak256(key)].state == KeyState.ADDED;
    }
    
    /**
     * @notice Get all active keys for an AID
     */
    function activeKeysOf(uint256 aid) external view returns (bytes32[] memory) {
        bytes32[] storage allKeys = keyHashes[aid];
        uint256 count = keyCount[aid];
        bytes32[] memory active = new bytes32[](count);
        
        uint256 idx = 0;
        for (uint256 i = 0; i < allKeys.length && idx < count; i++) {
            if (keys[aid][allKeys[i]].state == KeyState.ADDED) {
                active[idx++] = allKeys[i];
            }
        }
        
        return active;
    }
    
    /**
     * @notice Get key metadata
     */
    function keyDataOf(uint256 aid, bytes32 keyHash) external view returns (
        KeyState state,
        KeyType keyType,
        uint256 addedAt,
        uint256 removedAt
    ) {
        KeyData storage data = keys[aid][keyHash];
        return (data.state, data.keyType, data.addedAt, data.removedAt);
    }
    
    /*//////////////////////////////////////////////////////////////
                               ADMIN
    //////////////////////////////////////////////////////////////*/
    
    function setMaxKeysPerAid(uint256 _max) external onlyOwner {
        maxKeysPerAid = _max;
    }
    
    function pause() external onlyOwner {
        _pause();
    }
    
    function unpause() external onlyOwner {
        _unpause();
    }
    
    /*//////////////////////////////////////////////////////////////
                              HELPERS
    //////////////////////////////////////////////////////////////*/
    
    function _recoverSigner(bytes32 digest, bytes calldata signature) internal pure returns (address) {
        require(signature.length == 65, "Invalid signature length");
        
        bytes32 r;
        bytes32 s;
        uint8 v;
        
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        
        if (v < 27) v += 27;
        
        return ecrecover(digest, v, r, s);
    }
}

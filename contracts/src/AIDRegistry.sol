// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title AIDRegistry
 * @notice Registry for Agent IDs (AIDs) - the root identity primitive for agents
 * @dev Inspired by Farcaster's IdRegistry, adapted for autonomous agents
 */
contract AIDRegistry is Ownable, Pausable {
    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/
    
    error HasId();                    // Address already has an AID
    error HasNoId();                  // Address does not have an AID
    error Unauthorized();             // Caller not authorized
    error InvalidRecovery();          // Invalid recovery address
    error Escrow();                   // AID is in escrow (recovery pending)
    
    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/
    
    /// @notice Emitted when a new AID is registered
    event Register(address indexed to, uint256 indexed aid, address recovery);
    
    /// @notice Emitted when an AID is transferred
    event Transfer(address indexed from, address indexed to, uint256 indexed aid);
    
    /// @notice Emitted when recovery address is changed
    event ChangeRecovery(uint256 indexed aid, address indexed recovery);
    
    /// @notice Emitted when recovery is initiated
    event RequestRecovery(address indexed from, address indexed to, uint256 indexed aid);
    
    /// @notice Emitted when recovery is cancelled
    event CancelRecovery(address indexed by, uint256 indexed aid);
    
    /// @notice Emitted when recovery is completed
    event Recover(address indexed from, address indexed to, uint256 indexed aid);
    
    /*//////////////////////////////////////////////////////////////
                                 STORAGE
    //////////////////////////////////////////////////////////////*/
    
    /// @notice Total number of AIDs registered
    uint256 public aidCounter;
    
    /// @notice Mapping of AID to custody address
    mapping(uint256 => address) public custodyOf;
    
    /// @notice Mapping of custody address to AID
    mapping(address => uint256) public aidOf;
    
    /// @notice Mapping of AID to recovery address
    mapping(uint256 => address) public recoveryOf;
    
    /// @notice Recovery escrow: AID => destination address
    mapping(uint256 => address) public recoveryDestinationOf;
    
    /// @notice Recovery escrow deadline: AID => timestamp
    mapping(uint256 => uint256) public recoveryDeadlineOf;
    
    /// @notice Recovery delay period (default 3 days)
    uint256 public recoveryPeriod = 3 days;
    
    /// @notice Registration fee in wei
    uint256 public registrationFee;
    
    /// @notice Treasury address for fees
    address public treasury;
    
    /*//////////////////////////////////////////////////////////////
                               CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/
    
    constructor(
        address _owner,
        address _treasury,
        uint256 _registrationFee
    ) Ownable(_owner) {
        treasury = _treasury;
        registrationFee = _registrationFee;
    }
    
    /*//////////////////////////////////////////////////////////////
                            REGISTRATION
    //////////////////////////////////////////////////////////////*/
    
    /**
     * @notice Register a new AID for the caller
     * @param recovery The recovery address for this AID
     * @return aid The newly assigned Agent ID
     */
    function register(address recovery) external payable whenNotPaused returns (uint256 aid) {
        return _register(msg.sender, recovery);
    }
    
    /**
     * @notice Register a new AID for another address (sponsored registration)
     * @param to The address that will own the AID
     * @param recovery The recovery address for this AID
     * @return aid The newly assigned Agent ID
     */
    function registerFor(
        address to,
        address recovery
    ) external payable whenNotPaused returns (uint256 aid) {
        return _register(to, recovery);
    }
    
    /**
     * @dev Internal registration logic
     */
    function _register(address to, address recovery) internal returns (uint256 aid) {
        if (aidOf[to] != 0) revert HasId();
        if (recovery == address(0)) revert InvalidRecovery();
        if (msg.value < registrationFee) revert Unauthorized();
        
        // Assign new AID
        aid = ++aidCounter;
        
        // Set ownership
        custodyOf[aid] = to;
        aidOf[to] = aid;
        recoveryOf[aid] = recovery;
        
        // Transfer fee to treasury
        if (msg.value > 0) {
            (bool success, ) = treasury.call{value: msg.value}("");
            require(success, "Fee transfer failed");
        }
        
        emit Register(to, aid, recovery);
    }
    
    /*//////////////////////////////////////////////////////////////
                              TRANSFERS
    //////////////////////////////////////////////////////////////*/
    
    /**
     * @notice Transfer AID to a new custody address
     * @param to The new custody address
     */
    function transfer(address to) external whenNotPaused {
        uint256 aid = aidOf[msg.sender];
        if (aid == 0) revert HasNoId();
        if (aidOf[to] != 0) revert HasId();
        if (recoveryDeadlineOf[aid] != 0) revert Escrow();
        
        _transfer(aid, msg.sender, to);
    }
    
    /**
     * @dev Internal transfer logic
     */
    function _transfer(uint256 aid, address from, address to) internal {
        custodyOf[aid] = to;
        aidOf[to] = aid;
        delete aidOf[from];
        
        emit Transfer(from, to, aid);
    }
    
    /*//////////////////////////////////////////////////////////////
                              RECOVERY
    //////////////////////////////////////////////////////////////*/
    
    /**
     * @notice Change the recovery address for your AID
     * @param recovery The new recovery address
     */
    function changeRecovery(address recovery) external whenNotPaused {
        uint256 aid = aidOf[msg.sender];
        if (aid == 0) revert HasNoId();
        if (recovery == address(0)) revert InvalidRecovery();
        
        recoveryOf[aid] = recovery;
        
        emit ChangeRecovery(aid, recovery);
    }
    
    /**
     * @notice Initiate recovery of an AID (called by recovery address)
     * @param aid The AID to recover
     * @param to The new custody address
     */
    function requestRecovery(uint256 aid, address to) external whenNotPaused {
        if (recoveryOf[aid] != msg.sender) revert Unauthorized();
        if (aidOf[to] != 0) revert HasId();
        
        recoveryDestinationOf[aid] = to;
        recoveryDeadlineOf[aid] = block.timestamp + recoveryPeriod;
        
        emit RequestRecovery(custodyOf[aid], to, aid);
    }
    
    /**
     * @notice Cancel a pending recovery (called by current custody)
     */
    function cancelRecovery() external whenNotPaused {
        uint256 aid = aidOf[msg.sender];
        if (aid == 0) revert HasNoId();
        if (recoveryDeadlineOf[aid] == 0) revert Unauthorized();
        
        delete recoveryDestinationOf[aid];
        delete recoveryDeadlineOf[aid];
        
        emit CancelRecovery(msg.sender, aid);
    }
    
    /**
     * @notice Complete a recovery after the escrow period
     * @param aid The AID to recover
     */
    function completeRecovery(uint256 aid) external whenNotPaused {
        if (recoveryOf[aid] != msg.sender) revert Unauthorized();
        if (recoveryDeadlineOf[aid] == 0) revert Unauthorized();
        if (block.timestamp < recoveryDeadlineOf[aid]) revert Escrow();
        
        address from = custodyOf[aid];
        address to = recoveryDestinationOf[aid];
        
        delete recoveryDestinationOf[aid];
        delete recoveryDeadlineOf[aid];
        
        _transfer(aid, from, to);
        
        emit Recover(from, to, aid);
    }
    
    /*//////////////////////////////////////////////////////////////
                               ADMIN
    //////////////////////////////////////////////////////////////*/
    
    /**
     * @notice Update registration fee
     */
    function setRegistrationFee(uint256 _fee) external onlyOwner {
        registrationFee = _fee;
    }
    
    /**
     * @notice Update treasury address
     */
    function setTreasury(address _treasury) external onlyOwner {
        treasury = _treasury;
    }
    
    /**
     * @notice Update recovery period
     */
    function setRecoveryPeriod(uint256 _period) external onlyOwner {
        recoveryPeriod = _period;
    }
    
    /**
     * @notice Pause registration and transfers
     */
    function pause() external onlyOwner {
        _pause();
    }
    
    /**
     * @notice Unpause registration and transfers
     */
    function unpause() external onlyOwner {
        _unpause();
    }
    
    /*//////////////////////////////////////////////////////////////
                               VIEWS
    //////////////////////////////////////////////////////////////*/
    
    /**
     * @notice Check if an address has an AID
     */
    function hasId(address owner) external view returns (bool) {
        return aidOf[owner] != 0;
    }
    
    /**
     * @notice Get recovery status for an AID
     */
    function recoveryStatus(uint256 aid) external view returns (
        bool inRecovery,
        address destination,
        uint256 deadline
    ) {
        deadline = recoveryDeadlineOf[aid];
        inRecovery = deadline != 0;
        destination = recoveryDestinationOf[aid];
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import {Test, console2} from "forge-std/Test.sol";
import {AIDRegistry} from "../src/AIDRegistry.sol";

contract AIDRegistryTest is Test {
    AIDRegistry public registry;
    
    address owner = address(0x1);
    address treasury = address(0x2);
    address alice = address(0x10);
    address bob = address(0x20);
    address recovery = address(0x30);
    
    uint256 constant FEE = 0.001 ether;
    
    function setUp() public {
        registry = new AIDRegistry(owner, treasury, FEE);
        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);
    }
    
    /*//////////////////////////////////////////////////////////////
                            REGISTRATION
    //////////////////////////////////////////////////////////////*/
    
    function test_Register() public {
        vm.prank(alice);
        uint256 aid = registry.register{value: FEE}(recovery);
        
        assertEq(aid, 1);
        assertEq(registry.aidOf(alice), 1);
        assertEq(registry.custodyOf(1), alice);
        assertEq(registry.recoveryOf(1), recovery);
    }
    
    function test_RegisterFor() public {
        vm.prank(bob);
        uint256 aid = registry.registerFor{value: FEE}(alice, recovery);
        
        assertEq(aid, 1);
        assertEq(registry.aidOf(alice), 1);
        assertEq(registry.custodyOf(1), alice);
    }
    
    function test_RevertWhen_AlreadyHasId() public {
        vm.prank(alice);
        registry.register{value: FEE}(recovery);
        
        vm.prank(alice);
        vm.expectRevert(AIDRegistry.HasId.selector);
        registry.register{value: FEE}(recovery);
    }
    
    function test_RevertWhen_InsufficientFee() public {
        vm.prank(alice);
        vm.expectRevert(AIDRegistry.Unauthorized.selector);
        registry.register{value: FEE - 1}(recovery);
    }
    
    function test_RevertWhen_InvalidRecovery() public {
        vm.prank(alice);
        vm.expectRevert(AIDRegistry.InvalidRecovery.selector);
        registry.register{value: FEE}(address(0));
    }
    
    /*//////////////////////////////////////////////////////////////
                              TRANSFERS
    //////////////////////////////////////////////////////////////*/
    
    function test_Transfer() public {
        vm.prank(alice);
        registry.register{value: FEE}(recovery);
        
        vm.prank(alice);
        registry.transfer(bob);
        
        assertEq(registry.aidOf(alice), 0);
        assertEq(registry.aidOf(bob), 1);
        assertEq(registry.custodyOf(1), bob);
    }
    
    function test_RevertTransfer_HasNoId() public {
        vm.prank(alice);
        vm.expectRevert(AIDRegistry.HasNoId.selector);
        registry.transfer(bob);
    }
    
    function test_RevertTransfer_DestinationHasId() public {
        vm.prank(alice);
        registry.register{value: FEE}(recovery);
        
        vm.prank(bob);
        registry.register{value: FEE}(recovery);
        
        vm.prank(alice);
        vm.expectRevert(AIDRegistry.HasId.selector);
        registry.transfer(bob);
    }
    
    /*//////////////////////////////////////////////////////////////
                              RECOVERY
    //////////////////////////////////////////////////////////////*/
    
    function test_ChangeRecovery() public {
        vm.prank(alice);
        registry.register{value: FEE}(recovery);
        
        address newRecovery = address(0x40);
        vm.prank(alice);
        registry.changeRecovery(newRecovery);
        
        assertEq(registry.recoveryOf(1), newRecovery);
    }
    
    function test_RecoveryFlow() public {
        // Register
        vm.prank(alice);
        registry.register{value: FEE}(recovery);
        
        // Initiate recovery
        vm.prank(recovery);
        registry.requestRecovery(1, bob);
        
        (bool inRecovery, address dest, uint256 deadline) = registry.recoveryStatus(1);
        assertTrue(inRecovery);
        assertEq(dest, bob);
        assertGt(deadline, block.timestamp);
        
        // Wait for escrow period
        vm.warp(block.timestamp + 3 days + 1);
        
        // Complete recovery
        vm.prank(recovery);
        registry.completeRecovery(1);
        
        assertEq(registry.custodyOf(1), bob);
        assertEq(registry.aidOf(bob), 1);
        assertEq(registry.aidOf(alice), 0);
    }
    
    function test_CancelRecovery() public {
        vm.prank(alice);
        registry.register{value: FEE}(recovery);
        
        vm.prank(recovery);
        registry.requestRecovery(1, bob);
        
        // Custody can cancel
        vm.prank(alice);
        registry.cancelRecovery();
        
        (bool inRecovery,,) = registry.recoveryStatus(1);
        assertFalse(inRecovery);
    }
    
    function test_RevertRecovery_TooEarly() public {
        vm.prank(alice);
        registry.register{value: FEE}(recovery);
        
        vm.prank(recovery);
        registry.requestRecovery(1, bob);
        
        // Try to complete before deadline
        vm.prank(recovery);
        vm.expectRevert(AIDRegistry.Escrow.selector);
        registry.completeRecovery(1);
    }
    
    function test_RevertTransfer_DuringRecovery() public {
        vm.prank(alice);
        registry.register{value: FEE}(recovery);
        
        vm.prank(recovery);
        registry.requestRecovery(1, bob);
        
        // Cannot transfer during recovery
        vm.prank(alice);
        vm.expectRevert(AIDRegistry.Escrow.selector);
        registry.transfer(address(0x50));
    }
    
    /*//////////////////////////////////////////////////////////////
                               ADMIN
    //////////////////////////////////////////////////////////////*/
    
    function test_SetFee() public {
        vm.prank(owner);
        registry.setRegistrationFee(0.01 ether);
        
        assertEq(registry.registrationFee(), 0.01 ether);
    }
    
    function test_Pause() public {
        vm.prank(owner);
        registry.pause();
        
        vm.prank(alice);
        vm.expectRevert();
        registry.register{value: FEE}(recovery);
    }
}

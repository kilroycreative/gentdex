// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import {Script, console2} from "forge-std/Script.sol";
import {AIDRegistry} from "../src/AIDRegistry.sol";
import {KeyRegistry} from "../src/KeyRegistry.sol";

contract DeployScript is Script {
    function run() public {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);
        address treasury = vm.envOr("TREASURY", deployer);
        uint256 registrationFee = vm.envOr("REGISTRATION_FEE", uint256(0.001 ether)); // ~$3 at current prices
        
        console2.log("Deployer:", deployer);
        console2.log("Treasury:", treasury);
        console2.log("Registration Fee:", registrationFee);
        
        vm.startBroadcast(deployerPrivateKey);
        
        // Deploy AID Registry
        AIDRegistry aidRegistry = new AIDRegistry(
            deployer,   // owner
            treasury,   // treasury
            registrationFee
        );
        console2.log("AIDRegistry deployed at:", address(aidRegistry));
        
        // Deploy Key Registry
        KeyRegistry keyRegistry = new KeyRegistry(
            deployer,
            address(aidRegistry)
        );
        console2.log("KeyRegistry deployed at:", address(keyRegistry));
        
        vm.stopBroadcast();
        
        // Write deployment addresses
        string memory json = string(abi.encodePacked(
            '{"aidRegistry":"', vm.toString(address(aidRegistry)),
            '","keyRegistry":"', vm.toString(address(keyRegistry)),
            '","network":"', vm.toString(block.chainid),
            '","deployer":"', vm.toString(deployer),
            '"}'
        ));
        vm.writeFile("./deployments.json", json);
    }
}

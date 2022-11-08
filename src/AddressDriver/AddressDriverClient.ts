import type { Network } from '@ethersproject/networks';
import type { JsonRpcProvider, JsonRpcSigner } from '@ethersproject/providers';
import type { BigNumberish, BytesLike, ContractTransaction } from 'ethers';
import { ethers, BigNumber, constants } from 'ethers';
import type { DripsReceiverStruct, SplitsReceiverStruct } from 'contracts/AddressDriver';
import type { CallStruct, NetworkConfig } from 'src/common/types';
import CallerClient from '../Caller/CallerClient';
import DripsSubgraphClient from '../DripsSubgraph/DripsSubgraphClient';
import DripsHubClient from '../DripsHub/DripsHubClient';
import Utils from '../utils';
import {
	validateAddress,
	nameOf,
	isNullOrUndefined,
	validateDripsReceivers,
	validateSplitsReceivers,
	formatDripsReceivers,
	formatSplitReceivers
} from '../common/internals';
import { DripsErrors } from '../common/DripsError';
import type { AddressDriver as AddressDriverContract } from '../../contracts';
import { IERC20__factory, AddressDriver__factory } from '../../contracts';

/**
 * A client for managing Drips for a user identified by an Ethereum address.
 *
 * Each address can use an `AddressDriverClient` to control a `userId` equal to that address.
 *
 * No registration is required, an `AddressDriver`-based `userId` for each address is know upfront.
 * @see {@link https://github.com/radicle-dev/drips-contracts/blob/master/src/AddressDriver.sol AddressDriver} smart contract.
 */
export default class AddressDriverClient {
	#callerClient!: CallerClient;
	#addressDriverContract!: AddressDriverContract;

	#signer!: JsonRpcSigner;
	/**
	 * Returns the `AddressDriverClient`'s `signer`.
	 *
	 * This is the user to which the `AddressDriverClient` is linked and manages Drips.
	 *
	 * The `signer` is the `provider`'s signer.
	 *
	 */
	public get signer(): JsonRpcSigner {
		return this.#signer;
	}

	#signerAddress!: string;
	/** Returns the user address. */
	public get signerAddress(): string {
		return this.#signerAddress;
	}

	#dripsHub!: DripsHubClient;
	/** Returns a {@link DripsHubClient} connected to the same provider as the `AddressDriverClient.` */
	public get dripsHub(): DripsHubClient {
		return this.#dripsHub;
	}

	#subgraph!: DripsSubgraphClient;
	/** Returns a {@link DripsSubgraphClient} connected to the same network as the `AddressDriverClient.` */
	public get subgraph(): DripsSubgraphClient {
		return this.#subgraph;
	}

	#network!: Network;
	/**
	 * Returns the network the `AddressDriverClient` is connected to.
	 *
	 * The `network` is the `provider`'s network.
	 */
	public get network(): Network {
		return this.#network;
	}

	#provider!: JsonRpcProvider;
	/** Returns the `AddressDriverClient`'s `provider`. */
	public get provider(): JsonRpcProvider {
		return this.#provider;
	}

	#networkConfig!: NetworkConfig;
	/** Returns the `AddressDriverClient`'s `network` {@link NetworkConfig}. */
	public get networkConfig() {
		return this.#networkConfig;
	}

	private constructor() {}

	// TODO: Update the supported chains documentation comments.
	/**
	 * Creates a new immutable `AddressDriverClient` instance.
	 * @param  {JsonRpcProvider} provider The provider.
	 *
	 * The `provider` must have a `signer` associated with it.
	 *
	 * **The `signer` will be the user the new `AddressDriverClient` will manage Drips for and cannot be changed after creation**.
	 * (i.e., the new instance will control a `userId` equal to that address).
	 *
	 * The `provider` can connect to the following supported networks:
	 * - `goerli`: chain ID 5
	 * @param  {NetworkConfig} customNetworkConfig Overrides the network configuration.
	 * If it's `undefined` (default value) and the`provider` is officially supported by the client, the configuration will be automatically selected based on the `provider`'s network.
	 * @returns A `Promise` which resolves to the new `AddressDriverClient` instance.
	 * @throws {DripsErrors.argumentMissingError} if the `provider` is missing.
	 * @throws {DripsErrors.argumentError} if the `provider`'s singer is missing.
	 * @throws {DripsErrors.addressError} if the `provider`'s signer address is not valid.
	 * @throws {DripsErrors.unsupportedNetworkError} if the `provider` is connected to an unsupported network.
	 */
	public static async create(
		provider: JsonRpcProvider,
		customNetworkConfig?: NetworkConfig
	): Promise<AddressDriverClient> {
		if (!provider) {
			throw DripsErrors.argumentMissingError(
				`Could not create a new 'AddressDriverClient': '${nameOf({ provider })}' is missing.`,
				nameOf({ provider })
			);
		}

		const signer = provider.getSigner();
		const signerAddress = await signer?.getAddress();
		if (!signerAddress) {
			throw DripsErrors.argumentError(
				`Could not create a new 'AddressDriverClient': '${nameOf({ signerAddress })}' is missing.`,
				nameOf({ signerAddress }),
				provider
			);
		}
		validateAddress(signerAddress);

		const network = await provider.getNetwork();
		if (!Utils.Network.isSupportedChain(network?.chainId)) {
			throw DripsErrors.unsupportedNetworkError(
				`Could not create a new 'AddressDriverClient': the provider is connected to an unsupported network (name: '${network?.name}', chain ID: ${network?.chainId}). Supported chains are: ${Utils.Network.SUPPORTED_CHAINS}.`,
				network?.chainId
			);
		}
		const networkConfig = customNetworkConfig ?? Utils.Network.configs[network.chainId];

		const addressDriverClient = new AddressDriverClient();

		addressDriverClient.#signer = signer;
		addressDriverClient.#network = network;
		addressDriverClient.#provider = provider;
		addressDriverClient.#networkConfig = networkConfig;
		addressDriverClient.#signerAddress = await signer.getAddress();
		addressDriverClient.#dripsHub = await DripsHubClient.create(provider);
		addressDriverClient.#callerClient = await CallerClient.create(provider);
		addressDriverClient.#subgraph = DripsSubgraphClient.create(network.chainId);
		addressDriverClient.#addressDriverContract = AddressDriver__factory.connect(
			networkConfig.CONTRACT_ADDRESS_DRIVER,
			signer
		);

		return addressDriverClient;
	}

	/**
	 * Returns the remaining number of tokens the `AddressDriver` smart contract is allowed to spend on behalf of the user for the given ERC20 token.
	 * @param  {string} tokenAddress The ERC20 token address.
	 * @returns A `Promise` which resolves to the remaining number of tokens.
	 * @throws {DripsErrors.addressError} if the `tokenAddress` is not valid.
	 */
	public async getAllowance(tokenAddress: string): Promise<bigint> {
		validateAddress(tokenAddress);

		const signerAsErc20Contract = IERC20__factory.connect(tokenAddress, this.#signer);

		const allowance = await signerAsErc20Contract.allowance(
			this.#signerAddress,
			this.#networkConfig.CONTRACT_ADDRESS_DRIVER
		);

		return allowance.toBigInt();
	}

	/**
	 * Sets the maximum allowance value for the `AddressDriver` smart contract over the user's tokens for the given ERC20 token.
	 * @param  {string} tokenAddress The ERC20 token address.
	 * @returns A `Promise` which resolves to the `ContractTransaction`.
	 * @throws {DripsErrors.addressError} if the `tokenAddress` is not valid.
	 */
	public approve(tokenAddress: string): Promise<ContractTransaction> {
		validateAddress(tokenAddress);

		const signerAsErc20Contract = IERC20__factory.connect(tokenAddress, this.#signer);

		return signerAsErc20Contract.approve(this.#networkConfig.CONTRACT_ADDRESS_DRIVER, constants.MaxUint256);
	}

	/**
	 * Returns the user user ID.
	 *
	 * This is the user ID to which the `AddressDriverClient` is linked and manages Drips.
	 * @returns A `Promise` which resolves to the user ID.
	 */
	public async getUserId(): Promise<string> {
		const userId = await this.#addressDriverContract.calcUserId(this.#signerAddress);

		return userId.toString();
	}

	/**
	 * Returns the user ID for a given address.
	 * @param  {string} userAddress The user address.
	 * @returns A `Promise` which resolves to the user ID.
	 * @throws {DripsErrors.addressError} if the `userAddress` address is not valid.
	 */
	public async getUserIdByAddress(userAddress: string): Promise<string> {
		validateAddress(userAddress);

		const userId = await this.#addressDriverContract.calcUserId(userAddress);

		return userId.toString();
	}

	/**
	 * Collects the received and already split funds and transfers them from the `DripsHub` smart contract to an address.
	 * @param  {string} tokenAddress The ERC20 token address.
	 * @param  {string} transferToAddress The address to send collected funds to.
	 * @returns A `Promise` which resolves to the `ContractTransaction`.
	 * @throws {DripsErrors.addressError} if `tokenAddress` or `transferToAddress` is not valid.
	 */
	public async collect(tokenAddress: string, transferToAddress: string): Promise<ContractTransaction> {
		validateAddress(tokenAddress);
		validateAddress(transferToAddress);

		const collect: CallStruct = {
			value: 0,
			to: Utils.Network.configs[this.#network.chainId].CONTRACT_ADDRESS_DRIVER,
			data: this.#addressDriverContract.interface.encodeFunctionData('collect', [tokenAddress, transferToAddress])
		};

		return this.#callerClient.callBatched([collect]);
	}

	/**
	 * Gives funds to the receiver.
	 * The receiver can collect them immediately.
	 * Transfers funds from the user's wallet to the `DripsHub` smart contract.
	 * @param  {string} receiverUserId The receiver user ID.
	 * @param  {string} tokenAddress The ERC20 token address.
	 * @param  {BigNumberish} amount The amount to give (in the smallest unit, e.g. Wei). It must be greater than `0`.
	 * @returns A `Promise` which resolves to the `ContractTransaction`.
	 * @throws {DripsErrors.argumentMissingError} if the `receiverUserId` is missing.
	 * @throws {DripsErrors.addressError} if the `tokenAddress` is not valid.
	 * @throws {DripsErrors.argumentError} if the `amount` is less than or equal to `0`.
	 */
	public give(receiverUserId: string, tokenAddress: string, amount: BigNumberish): Promise<ContractTransaction> {
		if (isNullOrUndefined(receiverUserId)) {
			throw DripsErrors.argumentMissingError(
				`Could not give: '${nameOf({ receiverUserId })}' is missing.`,
				nameOf({ receiverUserId })
			);
		}

		validateAddress(tokenAddress);

		if (!amount || amount < 0) {
			throw DripsErrors.argumentError(
				`Could not give: '${nameOf({ amount })}' must be greater than 0.`,
				nameOf({ amount }),
				amount
			);
		}

		const give: CallStruct = {
			value: 0,
			to: Utils.Network.configs[this.#network.chainId].CONTRACT_ADDRESS_DRIVER,
			data: this.#addressDriverContract.interface.encodeFunctionData('give', [receiverUserId, tokenAddress, amount])
		};

		return this.#callerClient.callBatched([give]);
	}

	/**
	 * Sets the splits configuration.
	 * @param  {SplitsReceiverStruct[]} receivers The splits receivers (max `200`).
	 * Each splits receiver will be getting `weight / TOTAL_SPLITS_WEIGHT` share of the funds.
	 * Duplicate receivers are not allowed and will only be processed once.
	 * Pass an empty array if you want to clear all receivers.
	 * @returns A `Promise` which resolves to the `ContractTransaction`.
	 * @throws {DripsErrors.argumentMissingError} if `receivers` are missing.
	 * @throws {DripsErrors.argumentError} if `receivers`' count exceeds the max allowed splits receivers.
	 * @throws {DripsErrors.splitsReceiverError} if any of the `receivers` is not valid.
	 */
	public setSplits(receivers: SplitsReceiverStruct[]): Promise<ContractTransaction> {
		validateSplitsReceivers(receivers);

		const setSplits: CallStruct = {
			value: 0,
			to: Utils.Network.configs[this.#network.chainId].CONTRACT_ADDRESS_DRIVER,
			data: this.#addressDriverContract.interface.encodeFunctionData('setSplits', [formatSplitReceivers(receivers)])
		};

		return this.#callerClient.callBatched([setSplits]);
	}

	/**
	 * Sets a drips configuration.
	 * Transfers funds from the user's wallet to the `DripsHub` smart contract to fulfill the change of the drips balance.
	 * @param  {string} tokenAddress The ERC20 token address.
	 * @param  {DripsReceiverStruct[]} currentReceivers The drips receivers that were set in the last drips update.
	 * Pass an empty array if this is the first update.
	 * @param  {DripsReceiverStruct[]} newReceivers The new drips receivers (max `100`).
	 * Duplicate receivers are not allowed and will only be processed once.
	 * Pass an empty array if you want to clear all receivers.
	 * @param  {string} transferToAddress The address to send funds to in case of decreasing balance.
	 * @param  {BigNumberish} balanceDelta The drips balance change to be applied:
	 * - Positive to add funds to the drips balance.
	 * - Negative to remove funds from the drips balance.
	 * - `0` to leave drips balance as is (default value).
	 * @returns A `Promise` which resolves to the `ContractTransaction`.
	 * @throws {DripsErrors.argumentMissingError} if any of the required parameters is missing.
	 * @throws {DripsErrors.addressError} if `tokenAddress` or `transferToAddress` is not valid.
	 * @throws {DripsErrors.argumentError} if `currentReceivers`' or `newReceivers`' count exceeds the max allowed drips receivers.
	 * @throws {DripsErrors.dripsReceiverError} if any of the `currentReceivers` or the `newReceivers` is not valid.
	 * @throws {DripsErrors.dripsReceiverConfigError} if any of the receivers' configuration is not valid.
	 */
	public setDrips(
		tokenAddress: string,
		currentReceivers: DripsReceiverStruct[],
		newReceivers: DripsReceiverStruct[],
		transferToAddress: string,
		balanceDelta: BigNumberish = 0
	): Promise<ContractTransaction> {
		validateAddress(tokenAddress);
		validateDripsReceivers(
			newReceivers.map((r) => ({
				userId: r.userId.toString(),
				config: Utils.DripsReceiverConfiguration.fromUint256(BigNumber.from(r.config).toBigInt())
			}))
		);
		validateDripsReceivers(
			currentReceivers.map((r) => ({
				userId: r.userId.toString(),
				config: Utils.DripsReceiverConfiguration.fromUint256(BigNumber.from(r.config).toBigInt())
			}))
		);

		if (isNullOrUndefined(transferToAddress)) {
			throw DripsErrors.argumentMissingError(
				`Could not set drips: '${nameOf({ transferToAddress })}' is missing.`,
				nameOf({ transferToAddress })
			);
		}

		const setDrips: CallStruct = {
			value: 0,
			to: Utils.Network.configs[this.#network.chainId].CONTRACT_ADDRESS_DRIVER,
			data: this.#addressDriverContract.interface.encodeFunctionData('setDrips', [
				tokenAddress,
				formatDripsReceivers(currentReceivers),
				balanceDelta,
				formatDripsReceivers(newReceivers),
				transferToAddress
			])
		};

		return this.#callerClient.callBatched([setDrips]);
	}

	/**
	 * Emits the user's metadata.
	 * The key and the value are _not_ standardized by the protocol, it's up to the user to establish and follow conventions to ensure compatibility with the consumers.
	 * @param  {BigNumberish} key The metadata key.
	 * @param  {BytesLike} value The metadata value.
	 * @returns A `Promise` which resolves to the `ContractTransaction`.
	 * @throws {DripsErrors.argumentMissingError} if any of the required parameters is missing.
	 */
	public emitUserMetadata(key: BigNumberish, value: BytesLike): Promise<ContractTransaction> {
		if (isNullOrUndefined(key)) {
			throw DripsErrors.argumentMissingError(
				`Could not set emit user metadata: '${nameOf({ key })}' is missing.`,
				nameOf({ key })
			);
		}

		if (!value) {
			throw DripsErrors.argumentMissingError(
				`Could not set emit user metadata: '${nameOf({ value })}' is missing.`,
				nameOf({ value })
			);
		}

		const emitUserMetadata: CallStruct = {
			value: 0,
			to: Utils.Network.configs[this.#network.chainId].CONTRACT_ADDRESS_DRIVER,
			data: this.#addressDriverContract.interface.encodeFunctionData('emitUserMetadata', [key, value])
		};

		return this.#callerClient.callBatched([emitUserMetadata]);
	}

	/**
	 * Returns a user's address given a user ID.
	 * @param  {string} userId The user ID.
	 * @returns The user's address.
	 */
	public static getUserAddress = (userId: string): string => {
		const userIdAsBN = BigNumber.from(userId);

		const mask = BigNumber.from(1).shl(160).sub(BigNumber.from(1));
		const userAddress = userIdAsBN.and(mask);

		return ethers.utils.getAddress(userAddress.toHexString());
	};
}

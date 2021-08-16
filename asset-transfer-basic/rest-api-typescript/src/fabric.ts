/*
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Contract,
  DefaultEventHandlerStrategies,
  DefaultQueryHandlerStrategies,
  Gateway,
  GatewayOptions,
  Wallets,
  Network,
  BlockListener,
  BlockEvent,
  TransactionEvent,
  Wallet,
} from 'fabric-network';
import { Redis } from 'ioredis';
import * as config from './config';
import { logger } from './logger';
import {
  storeTransactionDetails,
  clearTransactionDetails,
  incrementRetryCount,
} from './redis';
import {
  AssetExistsError,
  AssetNotFoundError,
  TransactionError,
  TransactionNotFoundError,
} from './errors';
import protos from 'fabric-protos';

/*
 * Creates an in memory wallet to hold credentials for an Org1 and Org2 user
 *
 * In this sample there is a single user for each MSP ID to demonstrate how
 * a client app might submit transactions for different users
 *
 * Alternatively a REST server could use its own identity for all transactions,
 * or it could use credentials supplied in the REST requests
 */
export const createWallet = async (): Promise<Wallet> => {
  const wallet = await Wallets.newInMemoryWallet();

  const org1Identity = {
    credentials: {
      certificate: config.certificateOrg1,
      privateKey: config.privateKeyOrg1,
    },
    mspId: config.mspIdOrg1,
    type: 'X.509',
  };

  await wallet.put(config.mspIdOrg1, org1Identity);

  const org2Identity = {
    credentials: {
      certificate: config.certificateOrg2,
      privateKey: config.privateKeyOrg2,
    },
    mspId: config.mspIdOrg2,
    type: 'X.509',
  };

  await wallet.put(config.mspIdOrg2, org2Identity);

  return wallet;
};

/*
 * Create a Gateway connection
 *
 * Gateway instances can and should be reused rather than connecting to submit every transaction
 */
export const createGateway = async (
  connectionProfile: Record<string, unknown>,
  identity: string,
  wallet: Wallet
): Promise<Gateway> => {
  logger.debug({ connectionProfile, identity }, 'Configuring gateway');

  const gateway = new Gateway();

  const options: GatewayOptions = {
    wallet,
    identity,
    discovery: { enabled: true, asLocalhost: config.asLocalhost },
    eventHandlerOptions: {
      commitTimeout: config.commitTimeout,
      endorseTimeout: config.endorseTimeout,
      strategy: DefaultEventHandlerStrategies.PREFER_MSPID_SCOPE_ANYFORTX,
    },
    queryHandlerOptions: {
      timeout: config.queryTimeout,
      strategy: DefaultQueryHandlerStrategies.PREFER_MSPID_SCOPE_ROUND_ROBIN,
    },
  };

  await gateway.connect(connectionProfile, options);

  return gateway;
};

export const getNetwork = async (gateway: Gateway): Promise<Network> => {
  const network = await gateway.getNetwork(config.channelName);
  return network;
};

export const getContracts = async (
  network: Network
): Promise<{ assetContract: Contract; qsccContract: Contract }> => {
  const assetContract = network.getContract(config.chaincodeName);
  const qsccContract = network.getContract('qscc');
  return { assetContract, qsccContract };
};

export const startRetryLoop = (contract: Contract, redis: Redis): void => {
  setInterval(
    async (redis) => {
      try {
        const pendingTransactionCount = await (redis as Redis).zcard(
          'index:txn:timestamp'
        );
        logger.debug(
          'Transactions awaiting retry: %d',
          pendingTransactionCount
        );

        // TODO pick a random transaction instead to reduce chances of
        // clashing with other instances? Currently no zrandmember
        // command though...
        //   https://github.com/luin/ioredis/issues/1374
        const transactionIds = await (redis as Redis).zrange(
          'index:txn:timestamp',
          -1,
          -1
        );

        if (transactionIds.length > 0) {
          const transactionId = transactionIds[0];
          const savedTransaction = await (redis as Redis).hgetall(
            `txn:${transactionId}`
          );
          if (parseInt(savedTransaction.retries) >= config.maxRetryCount) {
            await clearTransactionDetails(redis, transactionId);
          } else {
            await retryTransaction(
              contract,
              redis,
              transactionId,
              savedTransaction
            );
          }
        }
      } catch (err) {
        // TODO just log?
        logger.error(err, 'error getting saved transaction state');
      }
    },
    config.retryDelay,
    redis
  );
};

export const evatuateTransaction = async (
  contract: Contract,
  transactionName: string,
  ...transactionArgs: string[]
): Promise<Buffer> => {
  const txn = contract.createTransaction(transactionName);
  const txnId = txn.getTransactionId();

  try {
    const payload = await txn.evaluate(...transactionArgs);
    logger.debug({ payload }, 'Evaluate transaction response received');
    return payload;
  } catch (err) {
    throw handleError(txnId, err);
  }
};

export const submitTransaction = async (
  contract: Contract,
  redis: Redis,
  transactionName: string,
  ...transactionArgs: string[]
): Promise<string> => {
  const txn = contract.createTransaction(transactionName);
  const txnId = txn.getTransactionId();
  const txnState = txn.serialize();
  const txnArgs = JSON.stringify(transactionArgs);
  const timestamp = Date.now();

  try {
    // Store the transaction details and set the event handler in case there
    // are problems later with commiting the transaction
    await storeTransactionDetails(redis, txnId, txnState, txnArgs, timestamp);
    txn.setEventHandler(DefaultEventHandlerStrategies.NONE);
    await txn.submit(...transactionArgs);
  } catch (err) {
    // If the transaction failed to endorse, there is no point attempting
    // to retry it later so clear the transaction details
    // TODO will this always catch endorsement errors or can they
    // arrive later?
    await clearTransactionDetails(redis, txnId);
    throw handleError(txnId, err);
  }

  return txnId;
};

// Unfortunately the chaincode samples do not use error codes, and the error
// message text is not the same for each implementation
const handleError = (transactionId: string, err: Error): Error => {
  // This regex needs to match the following error messages:
  //   "the asset %s already exists"
  //   "The asset ${id} already exists"
  //   "Asset %s already exists"
  const assetAlreadyExistsRegex = /([tT]he )?[aA]sset \w* already exists/g;
  const assetAlreadyExistsMatch = err.message.match(assetAlreadyExistsRegex);
  logger.debug(
    { message: err.message, result: assetAlreadyExistsMatch },
    'Checking for asset already exists message'
  );
  if (assetAlreadyExistsMatch) {
    return new AssetExistsError(assetAlreadyExistsMatch[0], transactionId);
  }

  // This regex needs to match the following error messages:
  //   "the asset %s does not exist"
  //   "The asset ${id} does not exist"
  //   "Asset %s does not exist"
  const assetDoesNotExistRegex = /([tT]he )?[aA]sset \w* does not exist/g;
  const assetDoesNotExistMatch = err.message.match(assetDoesNotExistRegex);
  logger.debug(
    { message: err.message, result: assetDoesNotExistMatch },
    'Checking for asset does not exist message'
  );
  if (assetDoesNotExistMatch) {
    return new AssetNotFoundError(assetDoesNotExistMatch[0], transactionId);
  }

  // This regex needs to match the following error messages:
  //   "Failed to get transaction with id %s, error Entry not found in index"
  const transactionDoesNotExistRegex =
    /Failed to get transaction with id [^,]*, error Entry not found in index/g;
  const transactionDoesNotExistMatch = err.message.match(
    transactionDoesNotExistRegex
  );
  logger.debug(
    { message: err.message, result: transactionDoesNotExistMatch },
    'Checking for transaction does not exist message'
  );
  if (transactionDoesNotExistMatch) {
    return new TransactionNotFoundError(
      transactionDoesNotExistMatch[0],
      transactionId
    );
  }

  logger.error(
    { transactionId: transactionId, error: err },
    'Unhandled transaction error'
  );
  return new TransactionError('Transaction error', transactionId);
};

export const retryTransaction = async (
  contract: Contract,
  redis: Redis,
  transactionId: string,
  savedTransaction: Record<string, string>
): Promise<void> => {
  logger.debug('Retrying transaction %s', transactionId);

  try {
    const transaction = contract.deserializeTransaction(
      Buffer.from(savedTransaction.state)
    );
    const args: string[] = JSON.parse(savedTransaction.args);

    await transaction.submit(...args);
    await clearTransactionDetails(redis, transactionId);
  } catch (err) {
    if (isDuplicateTransaction(err)) {
      logger.warn('Transaction %s has already been committed', transactionId);
      await clearTransactionDetails(redis, transactionId);
    } else {
      // TODO check for retry limit and update timestamp
      logger.warn(
        err,
        'Retry %d failed for transaction %s',
        savedTransaction.retries,
        transactionId
      );
      await incrementRetryCount(redis, transactionId);
    }
  }
};

const isDuplicateTransaction = (error: {
  errors: { endorsements: { details: string }[] }[];
}) => {
  // TODO this is horrible! Isn't it possible to check for TxValidationCode DUPLICATE_TXID somehow?
  try {
    const isDuplicateTxn = error?.errors?.some((err) =>
      err?.endorsements?.some((endorsement) =>
        endorsement?.details?.startsWith('duplicate transaction found')
      )
    );

    return isDuplicateTxn;
  } catch (err) {
    logger.warn(err, 'Error checking for duplicate transaction');
  }

  return false;
};

export const blockEventHandler = (redis: Redis): BlockListener => {
  const blockListner = async (event: BlockEvent) => {
    logger.debug('Block event received ');
    const transEvents: Array<TransactionEvent> = event.getTransactionEvents();

    for (const transEvent of transEvents) {
      if (transEvent && transEvent.isValid) {
        logger.debug(
          'Remove transation with txnId %s',
          transEvent.transactionId
        );
        await clearTransactionDetails(redis, transEvent.transactionId);
      }
    }
  };

  return blockListner;
};

export const getBlockHeight = async (
  qscc: Contract
): Promise<number | Long.Long> => {
  const data = await qscc.evaluateTransaction(
    'GetChainInfo',
    config.channelName
  );
  const info = protos.common.BlockchainInfo.decode(data);
  const blockHeight = info.height;
  logger.debug('Current block height: %d', blockHeight);
  return blockHeight;
};

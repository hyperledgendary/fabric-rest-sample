import * as config from './config';
import IORedis from 'ioredis';
import {
  clearTransactionDetails,
  incrementRetryCount,
  storeTransactionDetails,
} from './redis';
import { mocked } from 'ts-jest/utils';

jest.mock('ioredis', () => require('ioredis-mock/jest'));
jest.mock('./config');

// const redisOptions = {
//   port: config.redisPort,
//   host: config.redisHost,
//   username: config.redisUsername,
//   password: config.redisPassword,
// };
// const redis = new IORedis(redisOptions) as unknown as Redis;

// const MockedIORedis = mocked(IORedis, true)
const redisMock = mocked(new IORedis(), true);
console.log(redisMock);

// let delSpy;

// beforeEach(() => {
//   delSpy = jest.spyOn(redisMock, 'del')
// })
describe('Testing increment retries ', () => {
  const transactionId =
    '0ae62c01e4c4b112c3f3954a2f11243da76778e46df9ad2783bcbafc79652b95';
  it('Should  increment retries for valid transction id', async () => {
    await incrementRetryCount(redisMock, transactionId);
    expect(redisMock.hincrby).toHaveBeenCalledTimes(1);
  });

  it('Should not increment retries for empty transaction id ', async () => {
    await incrementRetryCount(redisMock, '');
    expect(redisMock.hincrby).toHaveBeenCalledTimes(0);
  });
});

describe('Testing storeTransactionDetails ', () => {
  const args = '["test111","red",400,"Jean",101]';
  const timestamp = 1628078044362;
  it('Should  store details for valid transction Id', async () => {
    const transactionId =
      '0ae62c01e4c4b112c3f3954a2f11243da76778e46df9ad2783bcbafc79652b95';
    const state = `{"name":"CreateAsset","nonce":"damqinq8nrI4n4qY8lFVsZw7RwG2ufrv","transactionId":${transactionId}`;
    await storeTransactionDetails(
      redisMock,
      transactionId,
      Buffer.from(state),
      args,
      timestamp
    );
    expect(redisMock.hset).toHaveBeenCalledTimes(1);
    expect(redisMock.zadd).toHaveBeenCalledTimes(1);
  });

  it('Should not  store details for empty transction Id', async () => {
    const transactionId = '';
    const state = `{"name":"CreateAsset","nonce":"damqinq8nrI4n4qY8lFVsZw7RwG2ufrv","transactionId":${transactionId}`;
    await storeTransactionDetails(
      redisMock,
      transactionId,
      Buffer.from(state),
      args,
      timestamp
    );
    expect(redisMock.hset).toHaveBeenCalledTimes(0);
    expect(redisMock.zadd).toHaveBeenCalledTimes(0);
  });
});

describe('Testing clearTransactionDetails ', () => {
  fit('Should  clear details ', async () => {
    // const delSpy = jest.spyOn(redisMock, 'del')
    const transactionId =
      '0ae62c01e4c4b112c3f3954a2f11243da76778e46df9ad2783bcbafc79652b95';
    await clearTransactionDetails(redisMock, transactionId);
    // expect(delSpy).toHaveBeenCalledTimes(1);
    expect(redisMock.zrem).toHaveBeenCalledTimes(1);
  });
});

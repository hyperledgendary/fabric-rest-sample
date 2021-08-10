/*
 * SPDX-License-Identifier: Apache-2.0
 */

import { mocked } from 'ts-jest/utils';

type IORedisModule = jest.Mocked<typeof import('ioredis')>;

const ioredis: IORedisModule = jest.createMockFromModule('ioredis');
// console.log(ioredis);

console.log(mocked(ioredis).getMockImplementation());

export default ioredis;

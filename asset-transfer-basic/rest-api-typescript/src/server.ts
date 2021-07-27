/*
 * SPDX-License-Identifier: Apache-2.0
 */

import helmet from 'helmet';
import { StatusCodes, getReasonPhrase } from 'http-status-codes';
import express, { Application, NextFunction, Request, Response } from 'express';
import pinoMiddleware from 'pino-http';

import { logger } from './logger';
import { assetsRouter } from './assets.router';
import { transactionsRouter } from './transactions.router';
import { getContracts, getGateway, getNetwork, getChainInfo } from './fabric';
import { redis } from './redis';
import { Contract } from 'fabric-network';

const {
  BAD_REQUEST,
  INTERNAL_SERVER_ERROR,
  NOT_FOUND,
  OK,
  SERVICE_UNAVAILABLE,
} = StatusCodes;

import { fabricAPIKeyStrategy } from './auth';
import passport from 'passport';
export const createServer = async (): Promise<Application> => {
  const app = express();

  app.use(
    pinoMiddleware({
      logger,
      customLogLevel: function customLogLevel(res, err) {
        if (
          res.statusCode >= BAD_REQUEST &&
          res.statusCode < INTERNAL_SERVER_ERROR
        ) {
          return 'warn';
        }

        if (res.statusCode >= INTERNAL_SERVER_ERROR || err) {
          return 'error';
        }

        return 'debug';
      },
    })
  );

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  //define passport startegy
  passport.use(fabricAPIKeyStrategy);

  //initialize passport js
  app.use(passport.initialize());

  if (process.env.NODE_ENV === 'development') {
    // TBC
  }

  if (process.env.NODE_ENV === 'production') {
    app.use(helmet());
  }

  const gateway = await getGateway();
  const network = await getNetwork(gateway);
  const contracts = await getContracts(network);
  app.set('contracts', contracts);
  app.set('redis', redis);
  app.set('network', network);

  // Health routes
  app.get('/ready', (_req, res) =>
    res.status(OK).json({
      status: getReasonPhrase(OK),
      timestamp: new Date().toISOString(),
    })
  );
  app.get('/live', async (_req, res) => {
    const qscc: Contract = _req.app.get('contracts').qscc;
    if ((await getChainInfo(qscc)) === true) {
      res.status(OK).json({
        status: getReasonPhrase(OK),
        timestamp: new Date().toISOString(),
      });
    } else {
      res.status(SERVICE_UNAVAILABLE).json({
        status: getReasonPhrase(SERVICE_UNAVAILABLE),
        timestamp: new Date().toISOString(),
      });
    }
  });

  // TODO delete me
  app.get('/error', (_req, _res) => {
    throw new Error('Example error');
  });

  app.use(
    '/api/assets',
    passport.authenticate('headerapikey', { session: false }),
    assetsRouter
  );
  app.use(
    '/api/transactions',
    passport.authenticate('headerapikey', { session: false }),
    transactionsRouter
  );

  // For everything else
  app.use((_req, res) =>
    res.status(NOT_FOUND).json({
      status: getReasonPhrase(NOT_FOUND),
      timestamp: new Date().toISOString(),
    })
  );

  // Print API errors
  // TBC in addition to pinoMiddleware errors?
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error(err);
    return res.status(INTERNAL_SERVER_ERROR).json({
      status: getReasonPhrase(INTERNAL_SERVER_ERROR),
      timestamp: new Date().toISOString(),
    });
  });

  return app;
};

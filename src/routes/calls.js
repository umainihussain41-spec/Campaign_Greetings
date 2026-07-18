import { Router } from 'express';
import * as store from '../store.js';

export const callsRouter = Router();

// All ingested individual-call rows, newest first (optionally filtered).
callsRouter.get('/', (req, res) => {
  res.json(store.listCalls({ campaign: req.query.campaign, limit: 500 }));
});

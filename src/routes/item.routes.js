import { Router } from 'express';
import * as controller from '../controllers/item.controller.js';
import { validate } from '../middleware/validate.js';
import { recordRoute } from '../logging/httpLogger.js';
import { authenticate } from '../middleware/authenticate.js';
import {
  itemIdParams,
  listItemsQuery,
  createItemBody,
  updateItemBody,
} from '../schemas/item.schema.js';

export const createItemRoutes = ({ limiters }) => {
  const router = Router();

  // Every item route requires a logged-in user (before validation, so anonymous
  // requests get 401 rather than details about what a valid request looks like)
  router.use(authenticate);

  // The short-search limit runs after validation, so it sees the trimmed q
  router.get('/', recordRoute, validate({ query: listItemsQuery }), limiters.shortSearch, controller.getAll);
  router.get('/:id', recordRoute, validate({ params: itemIdParams }), controller.getById);
  router.post('/', recordRoute, validate({ body: createItemBody }), controller.create);
  router.put('/:id', recordRoute, validate({ params: itemIdParams, body: updateItemBody }), controller.update);
  router.delete('/:id', recordRoute, validate({ params: itemIdParams }), controller.remove);

  return router;
};

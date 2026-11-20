import * as service from '../services/item.service.js';
import { performance } from 'node:perf_hooks';
import { setRequestAttributes } from '../telemetry/tracing.js';
import { recordListDuration, recordItemCreated } from '../telemetry/metrics.js';

// req.user is set by the authenticate middleware; the service uses it to
// restrict every query to the user's own items (admins see all)

export const getAll = async (req, res, next) => {
  try {
    // Validated by listItemsQuery: defaults applied, unknown params stripped
    const start = performance.now();
    const result = await service.findAll(req.user, req.query);
    // By search category: fast and slow searches share a route, so the
    // route-level latency metric can't tell them apart
    recordListDuration((performance.now() - start) / 1000, result.meta.filters.q);

    // Describe the search on the request's span so traces can be filtered by
    // it, e.g. "app.search.query_length < 3" to find unindexable searches.
    // The search text itself isn't recorded: users can type anything into it.
    const { filters, sort, order, page, limit, total } = result.meta;
    setRequestAttributes({
      'app.search.query_length': filters.q?.length,
      'app.list.filters': Object.keys(filters),
      'app.list.sort': `${sort} ${order}`,
      'app.list.page': page,
      'app.list.limit': limit,
      'app.list.total': total,
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
};

export const getById = async (req, res, next) => {
  try {
    const item = await service.findById(req.user, req.params.id);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    res.json(item);
  } catch (err) {
    next(err);
  }
};

export const create = async (req, res, next) => {
  try {
    const item = await service.create(req.user, req.body);
    recordItemCreated();
    res.status(201).json(item);
  } catch (err) {
    next(err);
  }
};

export const update = async (req, res, next) => {
  try {
    const item = await service.update(req.user, req.params.id, req.body);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    res.json(item);
  } catch (err) {
    next(err);
  }
};

export const remove = async (req, res, next) => {
  try {
    const deleted = await service.remove(req.user, req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Item not found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
};

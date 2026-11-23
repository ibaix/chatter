import { Hono } from 'hono';
import type { AlertRuleService } from '../alert-rules/AlertRuleService.js';
import { requirePermission } from '../auth/authRoutes.js';
import type { HardwarePoller } from '../polling/poller.js';
import { ALERT_RULES_DISABLED_ERROR } from '../sidecarConfig.js';
import { checkedJson } from './checks.js';
import { notFound, refuseSidecarOutbound } from './responses.js';
import { alertRulesSchema, copyAlertRulesSchema, testAlertQuerySchema } from './schemas.js';

/**
 * The list of a machine can have 50 rules, each with a query of 1000 letters. That is more than the normal JSON limit.
 * A letter can take more than one byte, so the limit has room for this.
 */
const RULES_BODY_LIMIT_BYTES = 512 * 1024;

/**
 * Read, change and copy the alert rules of a machine. Only a role with manage-machines can change them.
 * When `blockHistory` is true, changes and query tests answer 503 and call neither vmalert nor VictoriaMetrics.
 */
export function alertRuleRoutes(
  poller: HardwarePoller,
  alertRules: AlertRuleService,
  { blockHistory = false }: { blockHistory?: boolean } = {},
) {
  const canManageMachines = requirePermission('manage-machines');
  const noHistory = refuseSidecarOutbound(blockHistory, ALERT_RULES_DISABLED_ERROR);
  const isKnownMachine = (machineId: string) => poller.getMachine(machineId) !== null;

  return new Hono()
    .get('/machine/:id/alert-rules', c => {
      const machineId = c.req.param('id');
      if (!isKnownMachine(machineId)) return notFound(c);
      return c.json({ rules: alertRules.rulesOf(machineId) });
    })

    .put('/machine/:id/alert-rules', canManageMachines, noHistory, checkedJson(alertRulesSchema, RULES_BODY_LIMIT_BYTES), async c => {
      const machineId = c.req.param('id');
      if (!isKnownMachine(machineId)) return notFound(c);
      const result = await alertRules.saveRules(machineId, c.req.valid('json').rules);
      if (!result.ok) return c.json({ error: result.error, ruleIndex: result.ruleIndex }, 400);
      return c.json({ rules: result.rules, vmalertReloaded: result.vmalertReloaded });
    })

    .post('/machine/:id/alert-rules/copy', canManageMachines, noHistory, checkedJson(copyAlertRulesSchema), async c => {
      const machineId = c.req.param('id');
      if (!isKnownMachine(machineId)) return notFound(c);
      const { machineIds } = c.req.valid('json');
      const unknown = machineIds.find(id => !isKnownMachine(id));
      if (unknown) return c.json({ error: `Machine ${unknown} not found` }, 400);
      return c.json(await alertRules.copyRules(machineId, machineIds));
    })

    .post('/alert-rules/test', canManageMachines, noHistory, checkedJson(testAlertQuerySchema), async c => {
      const { machineId, query } = c.req.valid('json');
      if (!isKnownMachine(machineId)) return notFound(c);
      return c.json(await alertRules.testQuery(machineId, query));
    });
}

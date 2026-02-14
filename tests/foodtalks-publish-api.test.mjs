import test from 'node:test';
import assert from 'node:assert/strict';
import { publishFoodtalks } from '../src/publishers/foodtalks/publish-api.js';

test('publishFoodtalks forwards LOGIN_REQUIRED code from in-tab script', async () => {
  const result = await publishFoodtalks({
    tabId: 12,
    payload: { title: 'demo' },
    runtime: {
      executeInTab: async () => [
        {
          result: {
            ok: false,
            code: 'LOGIN_REQUIRED',
            error: 'FoodTalks 需要登录，请完成登录后继续'
          }
        }
      ]
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'LOGIN_REQUIRED');
  assert.equal(result.error, 'FoodTalks 需要登录，请完成登录后继续');
});

test('publishFoodtalks returns success detail from in-tab script', async () => {
  const result = await publishFoodtalks({
    tabId: 34,
    payload: { title: 'demo' },
    runtime: {
      executeInTab: async () => [
        {
          result: {
            ok: true,
            warnings: ['需手动确认封面'],
            detail: { contentLength: 128 }
          }
        }
      ]
    }
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.warnings, ['需手动确认封面']);
  assert.deepEqual(result.detail, { contentLength: 128 });
});

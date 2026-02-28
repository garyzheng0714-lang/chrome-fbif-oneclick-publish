import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FOODTALKS_LOGIN_URL,
  FOODTALKS_PUBLISH_URL,
  isFoodtalksAdminUrl,
  isFoodtalksLoginUrl,
  isFoodtalksPublishUrl,
  shouldRedirectToFoodtalksPublish
} from '../src/publishers/shared/foodtalks-urls.js';

test('foodtalks url helpers identify admin/login/publish pages', () => {
  assert.equal(isFoodtalksAdminUrl(FOODTALKS_LOGIN_URL), true);
  assert.equal(isFoodtalksAdminUrl(FOODTALKS_PUBLISH_URL), true);
  assert.equal(isFoodtalksAdminUrl('https://www.foodtalks.cn/#/login'), false);

  assert.equal(isFoodtalksLoginUrl(FOODTALKS_LOGIN_URL), true);
  assert.equal(isFoodtalksLoginUrl('https://admin-we.foodtalks.cn/#/login?redirect=/radar/news/publish'), true);
  assert.equal(isFoodtalksLoginUrl(FOODTALKS_PUBLISH_URL), false);

  assert.equal(isFoodtalksPublishUrl(FOODTALKS_PUBLISH_URL), true);
  assert.equal(isFoodtalksPublishUrl('https://admin-we.foodtalks.cn/#/radar/news/publish?from=test'), true);
  assert.equal(isFoodtalksPublishUrl(FOODTALKS_LOGIN_URL), false);
});

test('shouldRedirectToFoodtalksPublish only returns true for logged-in admin pages', () => {
  assert.equal(shouldRedirectToFoodtalksPublish('https://admin-we.foodtalks.cn/#/dashboard'), true);
  assert.equal(shouldRedirectToFoodtalksPublish('https://admin-we.foodtalks.cn/#/login'), false);
  assert.equal(shouldRedirectToFoodtalksPublish('https://admin-we.foodtalks.cn/#/radar/news/publish'), false);
  assert.equal(shouldRedirectToFoodtalksPublish('https://example.com/#/dashboard'), false);
});

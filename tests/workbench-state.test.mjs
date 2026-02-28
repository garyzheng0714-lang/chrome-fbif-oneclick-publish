import test from 'node:test';
import assert from 'node:assert/strict';
import { WORKBENCH_STATES, canTransition, getStatePermissions, transitionState } from '../src/shared/workbench-state.js';

test('workbench state machine allows core transitions', () => {
  assert.equal(canTransition(WORKBENCH_STATES.IDLE, WORKBENCH_STATES.READY), true);
  assert.equal(canTransition(WORKBENCH_STATES.READY, WORKBENCH_STATES.EXTRACTING), true);
  assert.equal(canTransition(WORKBENCH_STATES.EXTRACTING, WORKBENCH_STATES.COPY_READY), true);
  assert.equal(canTransition(WORKBENCH_STATES.COPY_READY, WORKBENCH_STATES.PUBLISH_WAIT_LOGIN), true);
  assert.equal(canTransition(WORKBENCH_STATES.PUBLISH_WAIT_LOGIN, WORKBENCH_STATES.DONE), true);
});

test('workbench state machine blocks invalid transitions', () => {
  assert.equal(canTransition(WORKBENCH_STATES.IDLE, WORKBENCH_STATES.DONE), false);
  assert.equal(canTransition(WORKBENCH_STATES.EXTRACTING, WORKBENCH_STATES.IDLE), false);
  assert.equal(transitionState(WORKBENCH_STATES.IDLE, WORKBENCH_STATES.DONE), WORKBENCH_STATES.IDLE);
});

test('state permissions follow extracting and content states', () => {
  const extracting = getStatePermissions(WORKBENCH_STATES.EXTRACTING);
  assert.equal(extracting.canExtract, false);
  assert.equal(extracting.canCopyAndOpen, false);

  const review = getStatePermissions(WORKBENCH_STATES.REVIEW);
  assert.equal(review.canExtract, true);
  assert.equal(review.canCopyAndOpen, true);
  assert.equal(review.canAutoPublish, true);
});

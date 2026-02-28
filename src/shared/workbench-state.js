export const WORKBENCH_STATES = {
  IDLE: 'idle',
  READY: 'ready',
  EXTRACTING: 'extracting',
  REVIEW: 'review',
  COPY_READY: 'copy_ready',
  PUBLISH_WAIT_LOGIN: 'publish_wait_login',
  DONE: 'done',
  ERROR: 'error'
};

const TRANSITIONS = {
  [WORKBENCH_STATES.IDLE]: [
    WORKBENCH_STATES.READY,
    WORKBENCH_STATES.EXTRACTING,
    WORKBENCH_STATES.ERROR
  ],
  [WORKBENCH_STATES.READY]: [
    WORKBENCH_STATES.EXTRACTING,
    WORKBENCH_STATES.ERROR,
    WORKBENCH_STATES.IDLE
  ],
  [WORKBENCH_STATES.EXTRACTING]: [
    WORKBENCH_STATES.REVIEW,
    WORKBENCH_STATES.COPY_READY,
    WORKBENCH_STATES.ERROR
  ],
  [WORKBENCH_STATES.REVIEW]: [
    WORKBENCH_STATES.COPY_READY,
    WORKBENCH_STATES.EXTRACTING,
    WORKBENCH_STATES.PUBLISH_WAIT_LOGIN,
    WORKBENCH_STATES.DONE,
    WORKBENCH_STATES.ERROR
  ],
  [WORKBENCH_STATES.COPY_READY]: [
    WORKBENCH_STATES.REVIEW,
    WORKBENCH_STATES.PUBLISH_WAIT_LOGIN,
    WORKBENCH_STATES.EXTRACTING,
    WORKBENCH_STATES.DONE,
    WORKBENCH_STATES.ERROR
  ],
  [WORKBENCH_STATES.PUBLISH_WAIT_LOGIN]: [
    WORKBENCH_STATES.DONE,
    WORKBENCH_STATES.COPY_READY,
    WORKBENCH_STATES.ERROR
  ],
  [WORKBENCH_STATES.DONE]: [
    WORKBENCH_STATES.EXTRACTING,
    WORKBENCH_STATES.COPY_READY,
    WORKBENCH_STATES.REVIEW,
    WORKBENCH_STATES.ERROR
  ],
  [WORKBENCH_STATES.ERROR]: [
    WORKBENCH_STATES.READY,
    WORKBENCH_STATES.EXTRACTING,
    WORKBENCH_STATES.REVIEW,
    WORKBENCH_STATES.IDLE
  ]
};

export function canTransition(current, next) {
  if (!current || !next) {
    return false;
  }
  return Boolean(TRANSITIONS[current]?.includes(next));
}

export function transitionState(current, next) {
  if (!current) {
    return next || WORKBENCH_STATES.IDLE;
  }
  if (!next || current === next) {
    return current;
  }
  return canTransition(current, next) ? next : current;
}

export function getStatePermissions(state) {
  const extracting = state === WORKBENCH_STATES.EXTRACTING;
  const hasContent = [
    WORKBENCH_STATES.REVIEW,
    WORKBENCH_STATES.COPY_READY,
    WORKBENCH_STATES.PUBLISH_WAIT_LOGIN,
    WORKBENCH_STATES.DONE
  ].includes(state);

  return {
    canExtract: !extracting,
    canCopyAndOpen: hasContent,
    canAutoPublish: hasContent && !extracting,
    canRunChecks: !extracting
  };
}

export const FOODTALKS_SELECTORS = {
  loginInputs: ['input[type="password"]', 'input[placeholder*="密码"]'],
  titleInputCandidates: [
    '.publish-form .el-form-item input',
    '.publish-form input',
    '.publish-form textarea'
  ],
  titleLabelKeywords: ['标题'],
  contentLabelKeywords: ['内容'],
  essayButtonCandidates: ['button.get-essay', '.get-essay', '.fixed-bottom .el-button.get-essay'],
  essayDialogCandidates: ['.get-essay-dialog', '.el-dialog.get-essay-dialog'],
  essayInputCandidates: ['.get-essay-dialog input', 'input[placeholder*="微信公众号文章网址"]'],
  essayConfirmButtonCandidates: ['.get-essay-dialog .el-button--primary'],
  draftButtonCandidates: ['button.draft-button', '.draft-button'],
  publishButtonCandidates: ['button.publish-button', '.publish-button'],
  editorIframeCandidates: ['iframe.tox-edit-area__iframe', '.tox-edit-area iframe'],
  editorContentEditableCandidates: [
    '.tox-edit-area [contenteditable="true"]',
    '.editor-wrap [contenteditable="true"]',
    '[contenteditable="true"]'
  ],
  sourceCodeButtonCandidates: [
    '.tox-tbtn[aria-label*="源代码"]',
    '.tox-tbtn[title*="源代码"]',
    '.tox-tbtn[aria-label*="Source code"]',
    '.tox-tbtn[title*="Source code"]',
    '.w-e-bar [title*="源代码"]',
    '.w-e-bar [aria-label*="源代码"]',
    '.w-e-bar [data-menu-key="sourceCode"]'
  ],
  sourceCodeDialogCandidates: [
    '.tox-dialog',
    '.el-dialog',
    '.w-e-modal',
    '[role="dialog"]'
  ],
  sourceCodeInputCandidates: [
    'textarea',
    '.CodeMirror textarea',
    'textarea[placeholder*="源代码"]',
    'textarea[placeholder*="源码"]',
    'textarea[placeholder*="HTML"]'
  ],
  sourceCodeSaveButtonCandidates: [
    '.tox-dialog .tox-button[title*="Save"]',
    '.el-dialog .el-button--primary'
  ]
};

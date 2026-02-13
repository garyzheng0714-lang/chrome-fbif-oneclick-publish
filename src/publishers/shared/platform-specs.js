export const PLATFORM_SPECS = {
  xiaohongshu: {
    maxImages: 9,
    createButtonTexts: ['新的创作', '上传图文', '图文'],
    titleSelectors: [
      'textarea[placeholder*="输入标题"]',
      'textarea[placeholder*="标题"]',
      'input[placeholder*="标题"]',
      '.d-text[placeholder*="标题"]',
      '.d-text input',
      '[class*="title"] textarea',
      '[class*="title"] input'
    ],
    editorSelectors: [
      '.ql-editor[contenteditable="true"]',
      '.ql-editor',
      '.tiptap.ProseMirror[contenteditable="true"]',
      '.tiptap.ProseMirror',
      '.ProseMirror[contenteditable="true"]',
      '.ProseMirror',
      'div[role="textbox"][contenteditable="true"]',
      'div[contenteditable="true"]'
    ],
    imageInputSelectors: [
      'input.upload-input[type="file"]',
      '.upload-input[type="file"]',
      'input[type="file"][accept*="image"]',
      'input[type="file"]'
    ],
    editorImageSelectors: ['.ql-editor img', '.ProseMirror img', '[class*="editor"] img', 'img']
  },
  zhihu: {
    publishUrl: 'https://zhuanlan.zhihu.com/write',
    titleSelectors: ['h1[contenteditable="true"]', '.Post-Title h1[contenteditable="true"]'],
    editorSelectors: [
      '.RichText.ztext[contenteditable="true"]',
      '.RichText[contenteditable="true"]',
      '.DraftEditor-root div[contenteditable="true"]',
      '.Editable-content'
    ]
  }
};

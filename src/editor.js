function rgbToHex(color) {
  if (!color || typeof color !== 'string') {
    return '#000000';
  }

  if (color.startsWith('#')) {
    return color;
  }

  const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  if (!match) {
    return '#000000';
  }

  return (
    '#' +
    match
      .slice(1, 4)
      .map((value) => Number(value).toString(16).padStart(2, '0'))
      .join('')
  );
}

export class RichEditor {
  constructor({
    editor,
    toolbar,
    headingSelect,
    editorPanel,
    formatPainterButton,
    fullscreenButton
  }) {
    this.editor = editor;
    this.toolbar = toolbar;
    this.headingSelect = headingSelect;
    this.editorPanel = editorPanel;
    this.formatPainterButton = formatPainterButton;
    this.fullscreenButton = fullscreenButton;

    this.painterStyle = null;
    this.isPainterArmed = false;

    this.bindToolbar();
    this.bindPainter();
    this.bindFullscreen();
  }

  bindToolbar() {
    this.toolbar.addEventListener('click', (event) => {
      const button = event.target.closest('[data-cmd]');
      if (!button) {
        return;
      }

      const command = button.dataset.cmd;
      const value = button.dataset.value ?? null;
      this.exec(command, value);
      this.editor.focus();
    });

    this.headingSelect.addEventListener('change', () => {
      const value = this.headingSelect.value;
      if (value === 'p') {
        this.exec('formatBlock', 'p');
      } else {
        this.exec('formatBlock', value);
      }
      this.editor.focus();
    });

    this.editor.addEventListener('mouseup', () => {
      if (this.isPainterArmed) {
        this.applyPainter();
      }
    });
  }

  bindPainter() {
    this.formatPainterButton.addEventListener('click', () => {
      if (this.isPainterArmed) {
        this.disablePainter();
        return;
      }

      const style = this.captureSelectionStyle();
      if (!style) {
        return;
      }

      this.painterStyle = style;
      this.isPainterArmed = true;
      this.formatPainterButton.classList.add('is-active');
    });
  }

  bindFullscreen() {
    this.fullscreenButton.addEventListener('click', () => {
      this.editorPanel.classList.toggle('is-fullscreen');
      document.body.classList.toggle('editor-fullscreen', this.editorPanel.classList.contains('is-fullscreen'));
      this.fullscreenButton.textContent = this.editorPanel.classList.contains('is-fullscreen')
        ? '退出全屏'
        : '全屏编辑';
    });
  }

  captureSelectionStyle() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return null;
    }

    const range = selection.getRangeAt(0);
    const container =
      range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;

    if (!container) {
      return null;
    }

    const style = window.getComputedStyle(container);

    return {
      isBold: Number(style.fontWeight) >= 600 || style.fontWeight === 'bold',
      isItalic: style.fontStyle === 'italic',
      isUnderline: style.textDecorationLine.includes('underline'),
      color: rgbToHex(style.color)
    };
  }

  applyPainter() {
    if (!this.painterStyle) {
      this.disablePainter();
      return;
    }

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return;
    }

    if (this.painterStyle.isBold) {
      this.exec('bold');
    }

    if (this.painterStyle.isItalic) {
      this.exec('italic');
    }

    if (this.painterStyle.isUnderline) {
      this.exec('underline');
    }

    this.exec('foreColor', this.painterStyle.color);
    this.disablePainter();
  }

  disablePainter() {
    this.isPainterArmed = false;
    this.painterStyle = null;
    this.formatPainterButton.classList.remove('is-active');
  }

  exec(command, value = null) {
    this.editor.focus();

    if (command === 'createLink') {
      const link = window.prompt('请输入链接地址');
      if (!link) {
        return;
      }
      document.execCommand('createLink', false, link.trim());
      return;
    }

    document.execCommand(command, false, value);
  }

  setContentHtml(html) {
    this.editor.innerHTML = html || '';
  }

  getContentHtml() {
    return this.editor.innerHTML;
  }

  getPlainText() {
    return this.editor.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  }

  getImages() {
    return [...this.editor.querySelectorAll('img')].map((img, index) => ({
      index,
      src: img.getAttribute('src') || '',
      alt: img.getAttribute('alt') || ''
    }));
  }
}

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  downloadFeishuImageAsDataUrl,
  extractFeishuDocByApi,
  isFeishuDocUrl,
  parseFeishuDocToken
} from '../src/sources/feishu/extractor.js';

function createJsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    headers: {
      get: () => 'application/json'
    },
    text: async () => JSON.stringify(payload)
  };
}

function createBinaryResponse(bytes, contentType = 'image/png') {
  return {
    ok: true,
    status: 200,
    headers: {
      get: (name) => (String(name || '').toLowerCase() === 'content-type' ? contentType : '')
    },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    text: async () => ''
  };
}

test('feishu doc url matcher and token parser work', () => {
  const url = 'https://foodtalks.feishu.cn/docx/UMsDdOwGNoUww0x6G1VcWoSLnMd?from=from_copylink';
  assert.equal(isFeishuDocUrl(url), true);
  assert.equal(parseFeishuDocToken(url), 'UMsDdOwGNoUww0x6G1VcWoSLnMd');
  assert.equal(isFeishuDocUrl('https://example.com/docx/test'), false);
});

test('extractFeishuDocByApi renders text/link/image blocks in order', async () => {
  const docToken = 'UMsDdOwGNoUww0x6G1VcWoSLnMd';
  const calls = [];

  const mockFetch = async (url) => {
    calls.push(url);
    const textUrl = String(url);

    if (textUrl.includes('/auth/v3/tenant_access_token/internal')) {
      return createJsonResponse({
        code: 0,
        msg: 'success',
        data: {
          tenant_access_token: 'tenant_token',
          expire: 7200
        }
      });
    }

    if (textUrl.endsWith(`/docx/v1/documents/${docToken}`)) {
      return createJsonResponse({
        code: 0,
        msg: 'success',
        data: {
          document: {
            title: '测试文档标题'
          }
        }
      });
    }

    if (textUrl.includes(`/docx/v1/documents/${docToken}/blocks`)) {
      return createJsonResponse({
        code: 0,
        msg: 'success',
        data: {
          has_more: false,
          page_token: '',
          items: [
            {
              block_id: docToken,
              block_type: 1,
              children: ['h1', 'p1', 'img1']
            },
            {
              block_id: 'h1',
              block_type: 4,
              heading2: {
                elements: [
                  {
                    text_run: {
                      content: '二级标题',
                      text_element_style: {}
                    }
                  }
                ]
              }
            },
            {
              block_id: 'p1',
              block_type: 2,
              text: {
                elements: [
                  {
                    text_run: {
                      content: '正文内容',
                      text_element_style: {}
                    }
                  },
                  {
                    text_run: {
                      content: '链接',
                      text_element_style: {
                        link: {
                          url: 'https%3A%2F%2Fexample.com%2Fpost'
                        }
                      }
                    }
                  }
                ]
              }
            },
            {
              block_id: 'img1',
              block_type: 27,
              image: {
                token: 'img_token_1'
              }
            }
          ]
        }
      });
    }

    throw new Error(`unexpected mock url: ${textUrl}`);
  };

  const result = await extractFeishuDocByApi({
    url: `https://foodtalks.feishu.cn/docx/${docToken}`,
    appId: 'app_id',
    appSecret: 'app_secret',
    fetchImpl: mockFetch
  });

  assert.equal(result.title, '测试文档标题');
  assert.equal(result.imageCount, 1);
  assert.equal(result.coverToken, 'img_token_1');
  assert.equal(result.paragraphCount, 3);
  assert.equal(result.images[0].token, 'img_token_1');
  assert.equal(result.contentHtml.includes('<h2>二级标题</h2>'), true);
  assert.equal(result.contentHtml.includes('data-feishu-token="img_token_1"'), true);
  assert.equal(result.contentHtml.includes('href="https://example.com/post"'), true);
  assert.equal(calls.some((url) => String(url).includes('/auth/v3/tenant_access_token/internal')), true);
});

test('downloadFeishuImageAsDataUrl returns data url', async () => {
  const bytes = new Uint8Array([137, 80, 78, 71]);

  const mockFetch = async (url) => {
    const textUrl = String(url);
    if (textUrl.includes('/auth/v3/tenant_access_token/internal')) {
      return createJsonResponse({
        code: 0,
        msg: 'success',
        data: {
          tenant_access_token: 'tenant_token',
          expire: 7200
        }
      });
    }

    if (textUrl.includes('/drive/v1/medias/token_1/download')) {
      return createBinaryResponse(bytes, 'image/png');
    }

    throw new Error(`unexpected mock url: ${textUrl}`);
  };

  const result = await downloadFeishuImageAsDataUrl({
    mediaToken: 'token_1',
    appId: 'app_id',
    appSecret: 'app_secret',
    fetchImpl: mockFetch
  });

  assert.equal(result.mimeType, 'image/png');
  assert.equal(result.dataUrl.startsWith('data:image/png;base64,'), true);
});

test('extractFeishuDocByApi renders complex blocks: list/table/grid/quote/iframe', async () => {
  const docToken = 'DOCTOKENCOMPLEX123';

  const mockFetch = async (url) => {
    const textUrl = String(url);

    if (textUrl.includes('/auth/v3/tenant_access_token/internal')) {
      return createJsonResponse({
        code: 0,
        msg: 'success',
        data: {
          tenant_access_token: 'tenant_token',
          expire: 7200
        }
      });
    }

    if (textUrl.endsWith(`/docx/v1/documents/${docToken}`)) {
      return createJsonResponse({
        code: 0,
        msg: 'success',
        data: {
          document: {
            title: '复杂结构文档'
          }
        }
      });
    }

    if (textUrl.includes(`/docx/v1/documents/${docToken}/blocks`)) {
      return createJsonResponse({
        code: 0,
        msg: 'success',
        data: {
          has_more: false,
          page_token: '',
          items: [
            { block_id: docToken, block_type: 1, children: ['call1', 'table1', 'quote1', 'iframe1', 'grid1'] },
            { block_id: 'call1', block_type: 19, children: ['li1', 'li2'], callout: { emoji_id: 'dart' } },
            {
              block_id: 'li1',
              block_type: 12,
              bullet: {
                elements: [{ text_run: { content: '要点A', text_element_style: { bold: true } } }]
              }
            },
            {
              block_id: 'li2',
              block_type: 13,
              ordered: {
                elements: [{ text_run: { content: '步骤1', text_element_style: {} } }]
              }
            },
            {
              block_id: 'table1',
              block_type: 31,
              children: ['c1', 'c2', 'c3', 'c4'],
              table: {
                cells: ['c1', 'c2', 'c3', 'c4'],
                property: {
                  row_size: 2,
                  column_size: 2,
                  merge_info: [
                    { row_span: 1, col_span: 2 },
                    { row_span: 1, col_span: 1 },
                    { row_span: 1, col_span: 1 },
                    { row_span: 1, col_span: 1 }
                  ],
                  column_width: [120, 200]
                }
              }
            },
            { block_id: 'c1', block_type: 32, children: ['c1t'] },
            {
              block_id: 'c1t',
              block_type: 2,
              text: {
                elements: [{ text_run: { content: '表头合并', text_element_style: {} } }]
              }
            },
            { block_id: 'c2', block_type: 32, children: ['c2t'] },
            {
              block_id: 'c2t',
              block_type: 2,
              text: {
                elements: [{ text_run: { content: '将被合并覆盖', text_element_style: {} } }]
              }
            },
            { block_id: 'c3', block_type: 32, children: ['c3t'] },
            {
              block_id: 'c3t',
              block_type: 2,
              text: {
                elements: [{ text_run: { content: '内容A', text_element_style: {} } }]
              }
            },
            { block_id: 'c4', block_type: 32, children: ['c4t'] },
            {
              block_id: 'c4t',
              block_type: 2,
              text: {
                elements: [{ text_run: { content: '内容B', text_element_style: {} } }]
              }
            },
            { block_id: 'quote1', block_type: 34, children: ['q1'] },
            {
              block_id: 'q1',
              block_type: 2,
              text: {
                elements: [{ text_run: { content: '引用段落', text_element_style: { italic: true } } }]
              }
            },
            {
              block_id: 'iframe1',
              block_type: 26,
              iframe: {
                component: {
                  url: 'https%3A%2F%2Fexample.com%2Fembed'
                }
              }
            },
            {
              block_id: 'grid1',
              block_type: 24,
              children: ['gc1', 'gc2'],
              grid: { column_size: 2 }
            },
            {
              block_id: 'gc1',
              block_type: 25,
              children: ['img1'],
              grid_column: { width_ratio: 40 }
            },
            {
              block_id: 'gc2',
              block_type: 25,
              children: ['p1'],
              grid_column: { width_ratio: 60 }
            },
            { block_id: 'img1', block_type: 27, image: { token: 'token_img_1' } },
            {
              block_id: 'p1',
              block_type: 2,
              text: {
                elements: [
                  {
                    text_run: {
                      content: '并排文本',
                      text_element_style: { italic: true }
                    }
                  }
                ]
              }
            }
          ]
        }
      });
    }

    throw new Error(`unexpected mock url: ${textUrl}`);
  };

  const result = await extractFeishuDocByApi({
    url: `https://foodtalks.feishu.cn/docx/${docToken}`,
    appId: 'app_id',
    appSecret: 'app_secret',
    fetchImpl: mockFetch
  });

  assert.equal(result.title, '复杂结构文档');
  assert.equal(result.imageCount, 1);
  assert.equal(result.contentHtml.includes('class="feishu-callout"'), true);
  assert.equal(result.contentHtml.includes('<ul><li>'), true);
  assert.equal(result.contentHtml.includes('<ol><li>'), true);
  assert.equal(result.contentHtml.includes('class="feishu-table"'), true);
  assert.equal(result.contentHtml.includes('colspan="2"'), true);
  assert.equal(result.contentHtml.includes('class="feishu-quote"'), true);
  assert.equal(result.contentHtml.includes('class="feishu-embed-link"'), true);
  assert.equal(result.contentHtml.includes('class="feishu-grid"'), true);
  assert.equal(result.contentHtml.includes('<em>并排文本</em>'), true);
});

test('extractFeishuDocByApi binds image caption from adjacent text block', async () => {
  const docToken = 'DOCWITHCAPTION001';

  const mockFetch = async (url) => {
    const textUrl = String(url);
    if (textUrl.includes('/auth/v3/tenant_access_token/internal')) {
      return createJsonResponse({
        code: 0,
        msg: 'success',
        data: {
          tenant_access_token: 'tenant_token',
          expire: 7200
        }
      });
    }

    if (textUrl.endsWith(`/docx/v1/documents/${docToken}`)) {
      return createJsonResponse({
        code: 0,
        msg: 'success',
        data: {
          document: {
            title: '图片备注文档'
          }
        }
      });
    }

    if (textUrl.includes(`/docx/v1/documents/${docToken}/blocks`)) {
      return createJsonResponse({
        code: 0,
        msg: 'success',
        data: {
          has_more: false,
          page_token: '',
          items: [
            { block_id: docToken, block_type: 1, children: ['img1', 'cap1', 'p1'] },
            {
              block_id: 'img1',
              block_type: 27,
              image: { token: 'caption_image_token', align: 2 }
            },
            {
              block_id: 'cap1',
              block_type: 2,
              text: {
                elements: [{ text_run: { content: '图片来源：FoodTalks', text_element_style: {} } }],
                style: { align: 2 }
              }
            },
            {
              block_id: 'p1',
              block_type: 2,
              text: {
                elements: [{ text_run: { content: '正文段落', text_element_style: {} } }],
                style: { align: 1 }
              }
            }
          ]
        }
      });
    }

    throw new Error(`unexpected mock url: ${textUrl}`);
  };

  const result = await extractFeishuDocByApi({
    url: `https://foodtalks.feishu.cn/docx/${docToken}`,
    appId: 'app_id',
    appSecret: 'app_secret',
    fetchImpl: mockFetch
  });

  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].caption, '图片来源：FoodTalks');
  assert.equal(result.contentHtml.includes('<figcaption style="text-align:center;">图片来源：FoodTalks</figcaption>'), true);
  assert.equal(result.contentHtml.includes('<p style="text-align:left;">正文段落</p>'), true);
});

test('extractFeishuDocByApi generic fallback handles code/todo/divider/file/unknown blocks', async () => {
  const docToken = 'DOCFALLBACK001';

  const mockFetch = async (url) => {
    const textUrl = String(url);
    if (textUrl.includes('/auth/v3/tenant_access_token/internal')) {
      return createJsonResponse({
        code: 0,
        msg: 'success',
        data: {
          tenant_access_token: 'tenant_token',
          expire: 7200
        }
      });
    }

    if (textUrl.endsWith(`/docx/v1/documents/${docToken}`)) {
      return createJsonResponse({
        code: 0,
        msg: 'success',
        data: {
          document: {
            title: '兜底块测试'
          }
        }
      });
    }

    if (textUrl.includes(`/docx/v1/documents/${docToken}/blocks`)) {
      return createJsonResponse({
        code: 0,
        msg: 'success',
        data: {
          has_more: false,
          page_token: '',
          items: [
            { block_id: docToken, block_type: 1, children: ['code1', 'todo1', 'div1', 'file1', 'unknown1', 'unknown2'] },
            {
              block_id: 'code1',
              block_type: 999,
              code: {
                language: 'javascript',
                elements: [{ text_run: { content: 'const a = 1;', text_element_style: {} } }]
              }
            },
            {
              block_id: 'todo1',
              block_type: 998,
              todo: {
                checked: true,
                elements: [{ text_run: { content: '完成检查', text_element_style: {} } }]
              }
            },
            {
              block_id: 'div1',
              block_type: 997,
              divider: {}
            },
            {
              block_id: 'file1',
              block_type: 996,
              file: {
                name: '报价单.pdf',
                url: 'https%3A%2F%2Fexample.com%2Fquote.pdf'
              }
            },
            {
              block_id: 'unknown1',
              block_type: 995,
              weird_payload: {
                elements: [{ text_run: { content: '未知内容兜底', text_element_style: {} } }]
              }
            },
            {
              block_id: 'unknown2',
              block_type: 994
            }
          ]
        }
      });
    }

    throw new Error(`unexpected mock url: ${textUrl}`);
  };

  const result = await extractFeishuDocByApi({
    url: `https://foodtalks.feishu.cn/docx/${docToken}`,
    appId: 'app_id',
    appSecret: 'app_secret',
    fetchImpl: mockFetch
  });

  assert.equal(result.title, '兜底块测试');
  assert.equal(result.contentHtml.includes('class="feishu-code-block" data-language="javascript"'), true);
  assert.equal(result.contentHtml.includes('class="feishu-todo"'), true);
  assert.equal(result.contentHtml.includes('type="checkbox" disabled checked'), true);
  assert.equal(result.contentHtml.includes('class="feishu-divider"'), true);
  assert.equal(result.contentHtml.includes('class="feishu-file"'), true);
  assert.equal(result.contentHtml.includes('报价单.pdf'), true);
  assert.equal(result.contentHtml.includes('class="feishu-unknown" data-feishu-key="weird_payload"'), true);
  assert.equal(result.contentHtml.includes('class="feishu-unsupported" data-feishu-block-type="994"'), true);
  assert.equal(result.validationHints.some((hint) => hint.includes('994')), true);
});

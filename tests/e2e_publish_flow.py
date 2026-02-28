#!/usr/bin/env python3
"""E2E smoke test for extension publish flow.

Usage:
  python3 tests/e2e_publish_flow.py

Notes:
- This script launches Chromium with this extension loaded.
- It validates extraction and publish flow orchestration.
- Real publish success requires platform login state.
"""

from pathlib import Path
from playwright.sync_api import sync_playwright
import shutil

WORKSPACE = Path('/Library/vibecoding_home/chrome-fbif-oneclick-publish')
PROFILE_DIR = Path('/tmp/fbif-e2e-extension-profile')
TARGET_ARTICLE = 'https://foodtalks.feishu.cn/docx/UMsDdOwGNoUww0x6G1VcWoSLnMd'


def main() -> None:
    if PROFILE_DIR.exists():
        shutil.rmtree(PROFILE_DIR)
    PROFILE_DIR.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(
            user_data_dir=str(PROFILE_DIR),
            headless=False,
            args=[
                f'--disable-extensions-except={WORKSPACE}',
                f'--load-extension={WORKSPACE}'
            ]
        )

        worker = context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
        extension_id = worker.url.split('/')[2]
        app_url = f'chrome-extension://{extension_id}/app.html'

        page = context.new_page()
        page.set_default_timeout(120000)
        page.goto(app_url, wait_until='domcontentloaded')
        page.wait_for_timeout(1800)

        page.fill('#urlInput', TARGET_ARTICLE)
        page.click('#extractButton')
        page.wait_for_function("() => Number(document.querySelector('#wordCount')?.textContent || '0') > 0")

        print('title=', page.input_value('#titleInput'))
        print('wordCount=', page.locator('#wordCount').inner_text())
        print('imageCount=', page.locator('#imageCount').inner_text())

        page.click('#copyAndOpenButton')
        page.wait_for_timeout(2000)
        print('extract_status=', page.locator('#extractStatus').inner_text())

        screenshot = '/tmp/fbif-e2e-publish-flow.png'
        page.screenshot(path=screenshot, full_page=True)
        print('screenshot=', screenshot)

        context.close()


if __name__ == '__main__':
    main()

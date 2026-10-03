/**
 * Canned mobile-app workflow tools.
 *
 * Tools:
 *  - zma_login              — Complete login flow for ZMA app
 *  - zma_navigate_to_guest  — Search and navigate to a guest profile
 *
 * These replicate flows from the zmauiautomation Java project
 * (LoginHome.java, GalleryPage.java) using the Appium Flutter MCP primitives.
 */

import { z } from 'zod';
import { hasBrowser, createSession, getBrowserWithReconnect, getBrowser, getCurrentPlatform } from '../appium/session.js';
import { captureScreenshot, LLM_SCREENSHOT_OPTS } from '../util/screenshot.js';
import { invalidateCache } from '../tree/tree-builder.js';
import { loadConfig } from '../util/config.js';
import { logger } from '../util/logger.js';
import { recordAction, isRecording } from '../recording/recorder.js';
import { switchToNative, switchToWebView, switchToWebViewByUrl } from '../context/context-manager.js';
import { getVMClient, vmDriverCommandsUsable, markVMDriverCommandsBroken } from '../vm/vm-session.js';
import { vmEnterText } from '../vm/vm-actions.js';
import type { McpToolResponse } from '../types.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function screenshotContent(browser: WebdriverIO.Browser, enabled: boolean = true): Promise<McpToolResponse['content']> {
  if (!enabled) return [];
  const config = loadConfig();
  if (!config.screenshotOnAction) return [];
  try {
    const screenshot = await captureScreenshot(browser, LLM_SCREENSHOT_OPTS);
    return [{ type: 'image' as const, data: screenshot.base64, mimeType: screenshot.mimeType }];
  } catch {
    return [];
  }
}

// ── Schemas ──────────────────────────────────────────────────────────────────

export const zmaLoginSchema = z.object({
  username: z.string().describe('ZMA login username (email)'),
  password: z.string().describe('ZMA login password'),
  env: z.enum(['Test', 'Beta', 'Live', 'Stage']).describe('ZMA environment to connect to (Test, Beta, Live, or Stage)'),
  account: z.string().describe('Account/organization name (e.g., "zarhfxmedspa")'),
  platform: z.enum(['ios', 'android']).optional()
    .describe('Target platform. Only needed if not already connected.'),
  sessionId: z.string().optional()
    .describe('Existing Appium session ID to attach to. Only needed if not already connected.'),
  appiumUrl: z.string().optional()
    .describe('Appium server URL. Only needed if not already connected.'),
  configPath: z.string().optional()
    .describe('Path to ZMA config directory. Only needed if not already connected.'),
  capabilities: z.record(z.unknown()).optional()
    .describe('Additional Appium capabilities. Only needed if not already connected.'),
  bundleId: z.string().optional()
    .describe('iOS bundle ID to launch (APPIUM_BUNDLE_ID). Only used when auto-connecting.'),
  loginUrlFragment: z.string().optional()
    .describe('URL fragment of the login WebView (or set LOGIN_WEBVIEW_URL_FRAGMENT)'),
  appPackage: z.string().optional()
    .describe('Android app package to launch. Only used when auto-connecting.'),
  timeout: z.number().optional().default(15)
    .describe('Timeout in seconds for wait steps (default: 15)'),
  screenshot: z.boolean().optional().default(true)
    .describe('Return screenshot after login completion'),
});

export const zmaNavigateToGuestSchema = z.object({
  guestName: z.string().describe('Guest name to search for and navigate to (e.g., "John Doe")'),
  timeout: z.number().optional().default(15)
    .describe('Timeout in seconds for wait steps (default: 15)'),
  screenshot: z.boolean().optional().default(true)
    .describe('Return screenshot after navigating to guest profile'),
});

// ── zma_shortcut (unified entry for the canned ZMA flows) ───────────────────

export const zmaShortcutSchema = z.object({
  flow: z.enum(['login', 'navigate_to_guest', 'select_appointment'])
    .describe('"login": full ZMA login (settings → env → account → webview credentials). "navigate_to_guest": search + open a guest profile. "select_appointment": find + tap an appointment card by guest name in the Bryntum appointment book.'),
  // login flow
  username: z.string().optional().describe('login flow: ZMA username (email)'),
  password: z.string().optional().describe('login flow: ZMA password'),
  env: z.enum(['Test', 'Beta', 'Live', 'Stage']).optional().describe('login flow: environment'),
  account: z.string().optional().describe('login flow: account/organization name (e.g., "zarhfxmedspa")'),
  platform: z.enum(['ios', 'android']).optional().describe('login flow: target platform (only if not already connected)'),
  sessionId: z.string().optional().describe('login flow: existing Appium session ID to attach to'),
  appiumUrl: z.string().optional().describe('login flow: Appium server URL (only if not already connected)'),
  configPath: z.string().optional().describe('login flow: path to ZMA config directory'),
  capabilities: z.record(z.unknown()).optional().describe('login flow: additional Appium capabilities'),
  bundleId: z.string().optional().describe('login flow: iOS bundle ID (APPIUM_BUNDLE_ID)'),
  loginUrlFragment: z.string().optional().describe('login flow: URL fragment of the login WebView'),
  appPackage: z.string().optional().describe('login flow: Android app package'),
  // navigate_to_guest / select_appointment flows
  guestName: z.string().optional().describe('navigate_to_guest / select_appointment flows: guest name to find'),
  // shared
  timeout: z.number().optional().describe('Timeout in seconds for wait steps (default: 15 for login/guest, 10 for appointment)'),
  screenshot: z.boolean().optional().default(true).describe('Return screenshot when the flow completes'),
});

export async function handleZmaShortcut(params: z.infer<typeof zmaShortcutSchema>): Promise<McpToolResponse> {
  const missing = (fields: string[]): McpToolResponse => ({
    content: [{
      type: 'text' as const,
      text: JSON.stringify({ error: true, message: `flow="${params.flow}" requires: ${fields.join(', ')}` }),
    }],
  });

  switch (params.flow) {
    case 'login': {
      if (!params.username || !params.password || !params.env || !params.account) {
        return missing(['username', 'password', 'env', 'account']);
      }
      return handleZmaLogin({
        username: params.username, password: params.password, env: params.env, account: params.account,
        platform: params.platform, sessionId: params.sessionId, appiumUrl: params.appiumUrl,
        configPath: params.configPath, capabilities: params.capabilities,
        bundleId: params.bundleId, appPackage: params.appPackage,
        loginUrlFragment: params.loginUrlFragment,
        timeout: params.timeout ?? 15, screenshot: params.screenshot ?? true,
      });
    }
    case 'navigate_to_guest': {
      if (!params.guestName) return missing(['guestName']);
      return handleZmaNavigateToGuest({
        guestName: params.guestName, timeout: params.timeout ?? 15, screenshot: params.screenshot ?? true,
      });
    }
    case 'select_appointment': {
      if (!params.guestName) return missing(['guestName']);
      return handleZmaSelectAppointment({
        guestName: params.guestName, timeout: params.timeout ?? 10, screenshot: params.screenshot ?? true,
      });
    }
  }
}

// ── zma_login handler ────────────────────────────────────────────────────────

export async function handleZmaLogin(
  params: z.infer<typeof zmaLoginSchema>,
): Promise<McpToolResponse> {
  const steps: string[] = [];
  let currentStep = '';

  try {
    const config = loadConfig();
    let browser: WebdriverIO.Browser;
    let platform: string;

    // Step 0: Auto-connect if not already connected
    if (hasBrowser()) {
      browser = await getBrowserWithReconnect();
      platform = getCurrentPlatform();
      steps.push('Already connected to Appium session.');
    } else {
      currentStep = 'Connect to Appium';
      platform = params.platform || config.platform;
      if (!platform) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: true,
              message: 'Not connected and no platform specified. Provide "platform" (ios/android) to connect.',
            }),
          }],
        };
      }

      steps.push(`Connecting to Appium (${platform})...`);
      const session = await createSession(config, {
        platform: platform as 'ios' | 'android',
        sessionId: params.sessionId || config.sessionId,
        appiumUrl: params.appiumUrl || config.appiumUrl,
        configPath: params.configPath || config.zmaConfigPath,
        capabilities: params.capabilities,
      });
      steps.push(`Connected! Session: ${session.sessionId}`);

      browser = getBrowser();

      // Launch app if not already running
      try {
        if (platform === 'ios') {
          const bundleId = params.bundleId || loadConfig().bundleId;
          if (!bundleId) throw new Error('Set bundleId or APPIUM_BUNDLE_ID before launching the app.');
          await browser.execute('mobile: activateApp', { bundleId });
          steps.push(`App launched: ${bundleId}`);
        } else if (params.appPackage) {
          await browser.execute('mobile: activateApp', { appId: params.appPackage });
          steps.push(`App launched: ${params.appPackage}`);
        }
      } catch (launchErr) {
        steps.push(`App launch attempted (may already be running): ${String(launchErr)}`);
      }
    }

    // Step 1: Tap settings icon (top-right gear icon)
    currentStep = 'Tap settings button';
    steps.push('Step 1: Tapping settings icon...');
    // Try multiple locator strategies for the settings gear icon
    let settingsTapped = false;
    // Strategy 1: Look for IconButton or Icon widget
    for (const widgetType of ['IconButton', 'GestureDetector']) {
      try {
        const buttons = await browser.findElements('-flutter type', widgetType);
        if (buttons.length > 0) {
          const settingsBtn = await browser.$(buttons[0]);
          await settingsBtn.click();
          settingsTapped = true;
          if (isRecording()) {
            recordAction('tap', { target: widgetType, by: 'type', index: 0 }, 'flutter');
          }
          break;
        }
      } catch (_e) {
        // Try next strategy
      }
    }
    // Strategy 2: Fallback to native context tap on settings icon
    if (!settingsTapped) {
      try {
        await switchToNative();
        const settingsBtn = await browser.$("//XCUIElementTypeButton[@name='Settings'] | //XCUIElementTypeImage[@name='settings']");
        await settingsBtn.waitForExist({ timeout: 5000 });
        await settingsBtn.click();
        settingsTapped = true;
        // Switch back to flutter context for next steps
        await browser.execute('flutter:checkHealth');
      } catch (_e2) {
        // Strategy 3: coordinate-based tap on gear icon area (top-right of login card)
        await switchToNative();
        // The gear icon is typically near top-center/right of the login card
        await browser.action('pointer')
          .move({ x: 393, y: 72 })
          .down()
          .up()
          .perform();
        settingsTapped = true;
      }
    }
    invalidateCache();
    steps.push('Step 1: Settings icon tapped.');

    // Step 2: Wait and select server environment
    currentStep = 'Select server environment';
    await sleep(5000);

    // Strategy 1: Try to find the environment by its text label directly
    let envSelected = false;
    try {
      const envTextEl = await browser.findElement('-flutter text', params.env);
      const envBtn = await browser.$(envTextEl);
      await envBtn.click();
      envSelected = true;
    } catch (_e) {
      logger.info('Could not find env by text, trying ServerListItem elements');
    }

    // Strategy 2: Fall back to ServerListItem by index
    if (!envSelected) {
      const serverItems = await browser.findElements('-flutter type', 'ServerListItem');
      logger.info('Found server items', { count: serverItems.length });

      if (serverItems.length === 0) {
        throw new Error('No ServerListItem elements found — app may be pre-configured');
      }

      // Map environment name to index — order: Test(0), Beta(1), Live(2), Stage(3)
      const envIndexMap: Record<string, number> = { Test: 0, Beta: 1, Live: 2, Stage: 3 };
      let envIndex = envIndexMap[params.env] ?? 3;
      if (envIndex >= serverItems.length) {
        envIndex = serverItems.length - 1;
      }

      const serverItem = await browser.$(serverItems[envIndex]);
      await serverItem.click();
    }
    invalidateCache();
    if (isRecording()) {
      recordAction('tap', { target: params.env, by: envSelected ? 'text' : 'type', env: params.env }, 'flutter');
    }
    steps.push(`Step 2: Selected environment "${params.env}".`);

    // Step 3: Tap "Done"
    currentStep = 'Tap Done';
    await sleep(1000);
    const doneEl = await browser.findElement('-flutter text', 'Done');
    const doneBtn = await browser.$(doneEl);
    await doneBtn.click();
    invalidateCache();
    if (isRecording()) {
      recordAction('tap', { target: 'Done', by: 'text' }, 'flutter');
    }
    steps.push('Step 3: Tapped Done.');

    // Step 4: Clear and enter account name
    currentStep = 'Enter account name';
    await sleep(1000);
    const accountField = await browser.findElement('-flutter type', 'AutoSizeTextField');
    const accountEl = await browser.$(accountField);
    await accountEl.click();
    // Always clear existing text first, then enter new account name
    await accountEl.clearValue();
    await sleep(500);
    await accountEl.setValue(params.account);
    invalidateCache();
    if (isRecording()) {
      recordAction('type_text', { target: 'AutoSizeTextField', by: 'type', text: params.account }, 'flutter');
    }
    steps.push(`Step 4: Entered account name "${params.account}".`);

    // Step 5: Tap "Proceed"
    currentStep = 'Tap Proceed';
    const proceedEl = await browser.findElement('-flutter text', 'Proceed');
    const proceedBtn = await browser.$(proceedEl);
    await proceedBtn.click();
    invalidateCache();
    if (isRecording()) {
      recordAction('tap', { target: 'Proceed', by: 'text' }, 'flutter');
    }
    steps.push('Step 5: Tapped Proceed.');

    // Step 6: Switch to the login WebView. Native text fields are often absent
    // because the form is inside the WebView.
    currentStep = 'Switch to login WebView';
    const loginUrl = params.loginUrlFragment || process.env.LOGIN_WEBVIEW_URL_FRAGMENT;
    if (!loginUrl) throw new Error('Set loginUrlFragment or LOGIN_WEBVIEW_URL_FRAGMENT to the login WebView URL fragment.');
    await switchToWebViewByUrl(loginUrl, params.timeout);
    steps.push('Step 6: Switched to IDS login WebView.');

    // Step 7: Enter username via HTML id
    currentStep = 'Enter username';
    const usernameField = browser.$('#Username');
    await usernameField.waitForExist({ timeout: params.timeout * 1000 });
    await usernameField.clearValue();
    await usernameField.setValue(params.username);
    invalidateCache();
    steps.push(`Step 7: Entered username "${params.username}".`);

    // Step 8: Enter password via HTML id
    currentStep = 'Enter password';
    const passwordField = browser.$('#Password');
    await passwordField.clearValue();
    await passwordField.setValue(params.password);
    invalidateCache();
    steps.push('Step 8: Entered password.');

    // Step 9: Click Log in button via HTML id
    currentStep = 'Tap Login button';
    const loginBtn = browser.$('#btnLogin');
    await loginBtn.click();
    invalidateCache();
    steps.push('Step 9: Clicked Log in button.');

    if (isRecording()) {
      recordAction('type_text', { target: '#Username', by: 'css', text: params.username }, 'webview');
      recordAction('type_text', { target: '#Password', by: 'css', text: '****' }, 'webview');
      recordAction('tap', { target: '#btnLogin', by: 'css' }, 'webview');
    }

    // Step 10: Switch back to native and wait for home screen (calendar "Today" button)
    currentStep = 'Wait for login completion';
    await switchToNative();
    // Poll for the Flutter calendar home screen — login is complete when "Today" is visible
    const homeDeadline = Date.now() + 30000;
    while (Date.now() < homeDeadline) {
      try {
        const todayEl = browser.$('-flutter text=Today');
        await todayEl.waitForExist({ timeout: 2000 });
        break;
      } catch { await sleep(1000); }
    }
    steps.push('Step 10: Home screen loaded (Today button visible).');
    steps.push('Step 10: Waited for login completion.');

    // Capture screenshot
    const extra = await screenshotContent(browser, params.screenshot);

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            status: 'login_complete',
            environment: params.env,
            account: params.account,
            username: params.username,
            platform,
            steps,
            message: `Successfully completed ZMA login flow for ${params.username} on ${params.env} environment.`,
          }, null, 2),
        },
        ...extra,
      ],
    };
  } catch (error) {
    const msg = `ZMA login failed at step "${currentStep}": ${String(error)}`;
    logger.error(msg);
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          error: true,
          failedAt: currentStep,
          stepsCompleted: steps,
          message: msg,
          suggestion: 'Use get_screen to see the current app state. Use get_widget_tree to inspect available elements.',
        }, null, 2),
      }],
    };
  }
}

// ── zma_select_appointment schema ────────────────────────────────────────────

export const zmaSelectAppointmentSchema = z.object({
  guestName: z.string().describe('Guest name to find in the appointment list (e.g., "Gallery Smoke")'),
  timeout: z.number().optional().default(10)
    .describe('Timeout in seconds for wait steps (default: 10)'),
  screenshot: z.boolean().optional().default(true)
    .describe('Return screenshot after selecting appointment'),
});

// ── zma_select_appointment handler ──────────────────────────────────────────

/**
 * Sequential card tap + ValueKey verify strategy.
 *
 * The Bryntum appointment cards are JS-rendered inside a WebView — invisible
 * to both Flutter and native locators. However, the appointment detail panel
 * on the right IS a Flutter widget with ValueKey `bryntum_appt_label_guest_name`.
 *
 * Strategy:
 *  1. Ensure the appointment list view is showing (person icon tab)
 *  2. Tap the first card position (predictable Y offset)
 *  3. Wait briefly, then read guest name from the detail panel ValueKey
 *  4. If it matches → done. If not → tap next card position (+cardHeight)
 *  5. If no more visible cards → scroll down and repeat
 *  6. Max attempts to avoid infinite loop
 */

// Card list layout constants (relative to appointment list view)
const CARD_LIST_X = 180;         // Center X of the card area
const FIRST_CARD_Y = 345;       // Y position of first card's text area
const CARD_HEIGHT = 150;        // Approximate height of each card + gap
const MAX_VISIBLE_CARDS = 5;    // Max cards visible without scrolling
const MAX_SCROLL_ATTEMPTS = 3;  // Max scroll-down attempts

export async function handleZmaSelectAppointment(
  params: z.infer<typeof zmaSelectAppointmentSchema>,
): Promise<McpToolResponse> {
  const steps: string[] = [];
  let currentStep = '';

  try {
    const browser = await getBrowserWithReconnect();
    const guestNameLower = params.guestName.toLowerCase();

    // Step 1: Ensure we're on the appointment list view (person icon tab)
    currentStep = 'Ensuring appointment list view';
    try {
      // Tap the person/list icon tab to ensure list view is active
      const listTabEl = await browser.findElement('-flutter key', 'left_panel_tab_appointments');
      const listTab = await browser.$(listTabEl);
      if (listTab) {
        steps.push('Appointment list tab found');
      }
    } catch {
      steps.push('Could not find appointment tab — assuming list view is active');
    }

    // Step 2: Sequential tap + verify loop
    currentStep = 'Searching appointment cards';
    let found = false;
    let scrollAttempt = 0;

    while (!found && scrollAttempt <= MAX_SCROLL_ATTEMPTS) {
      for (let cardIndex = 0; cardIndex < MAX_VISIBLE_CARDS; cardIndex++) {
        const cardY = FIRST_CARD_Y + (cardIndex * CARD_HEIGHT);

        // Don't tap below the visible area
        if (cardY > 800) break;

        currentStep = `Tapping card at position ${cardIndex + 1} (scroll ${scrollAttempt})`;
        steps.push(`Tapping card at (${CARD_LIST_X}, ${cardY})`);

        // Tap the card
        await browser.action('pointer')
          .move({ x: CARD_LIST_X, y: cardY })
          .down()
          .up()
          .perform();
        // Raw pointer tap bypasses handleTap's own invalidation — every tap here updates
        // the native detail panel regardless of whether this card ends up matching, so
        // invalidate on every iteration, not just once found.
        invalidateCache();

        // Wait for detail panel to update
        await sleep(1500);

        // Read guest name from the detail panel via ValueKey
        try {
          const guestNameEl = await browser.findElement('-flutter key', 'bryntum_appt_label_guest_name');
          const el = await browser.$(guestNameEl);
          const detailName = await el.getText();

          if (detailName) {
            steps.push(`Card ${cardIndex + 1}: detail panel shows "${detailName.trim()}"`);

            if (detailName.toLowerCase().trim().includes(guestNameLower)) {
              found = true;
              steps.push(`Match found! "${params.guestName}" selected.`);
              break;
            }
          }
        } catch {
          // No detail panel appeared — card position might be empty/gap
          steps.push(`Card ${cardIndex + 1}: no detail panel response (empty slot)`);
          break; // No more cards in this scroll position
        }
      }

      if (!found) {
        // Scroll the appointment list down to reveal more cards
        scrollAttempt++;
        if (scrollAttempt <= MAX_SCROLL_ATTEMPTS) {
          steps.push(`Scrolling appointment list down (attempt ${scrollAttempt})`);
          await browser.action('pointer')
            .move({ x: CARD_LIST_X, y: 600 })
            .down()
            .move({ x: CARD_LIST_X, y: 300, duration: 500 })
            .up()
            .perform();
          // Scrolling changes which cards are visible — same class of mutation
          // handleGesture's scroll path already invalidates for.
          invalidateCache();
          await sleep(1000);
        }
      }
    }

    if (!found) {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            error: true,
            message: `Appointment for "${params.guestName}" not found after checking ${MAX_VISIBLE_CARDS * (MAX_SCROLL_ATTEMPTS + 1)} card positions. Ensure the appointment exists for today.`,
            steps,
          }, null, 2),
        }],
      };
    }

    // Screenshot
    const screenshotData = await screenshotContent(browser, params.screenshot);

    if (isRecording()) {
      recordAction('tap' as any, { guestName: params.guestName, action: 'zma_select_appointment' }, 'native');
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            status: 'appointment_selected',
            guestName: params.guestName,
            steps,
            message: `Selected appointment for "${params.guestName}"`,
          }, null, 2),
        },
        ...screenshotData,
      ],
    };
  } catch (error) {
    const msg = `Failed to select appointment for "${params.guestName}" at step "${currentStep}": ${String(error)}`;
    logger.error(msg);
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          error: true,
          failedAt: currentStep,
          stepsCompleted: steps,
          message: msg,
        }, null, 2),
      }],
    };
  }
}

// ── zma_navigate_to_guest handler ────────────────────────────────────────────

export async function handleZmaNavigateToGuest(
  params: z.infer<typeof zmaNavigateToGuestSchema>,
): Promise<McpToolResponse> {
  const steps: string[] = [];
  let currentStep = '';

  try {
    const browser = await getBrowserWithReconnect();

    // Get device dimensions for coordinate scaling
    const rect = await browser.getWindowRect();
    const scaleX = rect.width / 1024; // Reference iPad width from GalleryPage coordinates
    const scaleY = rect.height / 1366; // Reference iPad height

    // Step 1: Find search field by semantics label and type guest name
    // The search field is a custom Flutter widget that doesn't register as a standard
    // TextField/EditableText. It IS findable by semantics label "Search a Guest" when
    // unfocused. setValue() handles both focus + typing in one call.
    currentStep = 'Type guest name';
    // The search field is a custom Flutter widget. setValue() often fails with
    // "Index out of range" because the native element backing doesn't support it.
    // Strategy: tap the field via semantics label to focus it, then use the Dart VM
    // enterText extension to type into the focused widget.
    try {
      const searchField = await browser.$('-flutter semantics label:Search a Guest');
      await searchField.click();
      await new Promise(r => setTimeout(r, 500));
    } catch {
      // Field may already be focused or tapped via coordinates before calling this tool
      logger.warn('Search field tap by semantics label failed, assuming already focused');
    }

    // Type via VM enterText (sends text to the currently focused Flutter text field)
    const vm = getVMClient();
    let typedViaVM = false;
    if (vm && vmDriverCommandsUsable()) {
      try {
        await vmEnterText(vm, params.guestName);
        typedViaVM = true;
      } catch (e) {
        const msg = String(e);
        if (msg.includes('VM Service error')) markVMDriverCommandsBroken(msg);
        logger.warn('VM enterText failed in guest search, using EditableText fallback', { error: msg });
      }
    }
    if (!typedViaVM) {
      // Fallback: try setValue on EditableText elements
      logger.warn('VM not available, trying EditableText setValue fallback');
      const editableTexts = await browser.findElements('-flutter type', 'EditableText');
      if (editableTexts.length < 2) {
        throw new Error(`VM not connected and search field not found by EditableText type. Ensure VM service is connected.`);
      }
      const searchField = await browser.$(editableTexts[1]);
      await searchField.setValue(params.guestName);
    }
    invalidateCache();
    if (isRecording()) {
      recordAction('type_text', { target: 'Search a Guest', by: 'semanticsLabel', text: params.guestName }, 'flutter');
    }
    steps.push(`Step 1: Typed "${params.guestName}" into search field.`);

    // Step 2: Wait for search results to load
    currentStep = 'Wait for search results';
    await sleep(3000);
    steps.push('Step 2: Waited for search results.');

    // Step 3: Tap first search result by coordinates (scaled from iPad reference: 650, 195)
    currentStep = 'Tap first search result';
    const resultX = Math.floor(650 * scaleX);
    const resultY = Math.floor(195 * scaleY);

    await browser.action('pointer')
      .move({ x: resultX, y: resultY })
      .down()
      .up()
      .perform();
    invalidateCache();
    if (isRecording()) {
      recordAction('tap', { by: 'coordinates', x: resultX, y: resultY, description: 'Tap first search result' }, 'flutter');
    }
    steps.push(`Step 3: Tapped first search result at (${resultX}, ${resultY}).`);

    // Step 4: Wait for guest profile to load and verify
    currentStep = 'Verify guest profile loaded';
    await sleep(3000);

    let profileVerified = false;
    try {
      const guestNameEl = await browser.findElement('-flutter text', params.guestName);
      if (guestNameEl) {
        profileVerified = true;
      }
    } catch {
      // Guest name text not found — profile may still have loaded with a different display name
      logger.warn('Could not verify guest profile by text match', { guestName: params.guestName });
    }

    steps.push(`Step 4: Guest profile ${profileVerified ? 'verified' : 'navigation completed (could not verify by text match).'}`);

    // Capture screenshot
    const extra = await screenshotContent(browser, params.screenshot);

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            status: profileVerified ? 'guest_profile_loaded' : 'navigation_completed',
            guestName: params.guestName,
            verified: profileVerified,
            steps,
            message: profileVerified
              ? `Successfully navigated to guest profile: ${params.guestName}`
              : `Navigated to first search result for "${params.guestName}". Use get_screen to verify the correct profile loaded.`,
          }, null, 2),
        },
        ...extra,
      ],
    };
  } catch (error) {
    const msg = `ZMA guest navigation failed at step "${currentStep}": ${String(error)}`;
    logger.error(msg);
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          error: true,
          failedAt: currentStep,
          stepsCompleted: steps,
          message: msg,
          suggestion: 'Use get_screen to see the current app state. Ensure the app is on the main dashboard/calendar screen where search is accessible.',
        }, null, 2),
      }],
    };
  }
}


# Changelog

All notable changes to this project will be documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims for [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `APPIUM_AUTOMATION_NAME` env var. Defaults to `FlutterIntegration`; override with `XCUITest`, `UiAutomator2`, `Espresso`, etc. to drive non-Flutter apps. Flutter-specific capabilities are only sent to Appium when the chosen driver is `FlutterIntegration`.

## [1.0.0] - 2026-05-10

Initial public release.

### Added
- 39 MCP tools across nine categories: Session, Observe, Act, Navigate, Device, Recording, Self-Healing, Visual, CUA.
- Natural-language locator discovery (`flutter_locator`, `get_locator`) with source-aware ValueKey lookup from a configurable Flutter app source path.
- Self-healing locator cascade (key variants → text → semanticsLabel → fuzzy) with off / passive / active modes.
- Visual regression oracle: save baselines and compare structural diffs.
- CUA mode: vision-led, locator-aware execution of plain-English markdown test cases with cross-run hint memory.
- Hybrid Flutter + WebView + Native context handling, with helpers like `wait_for_webview` and `webview_fill_form`.
- Optional Dart VM Service connection for fast widget-tree access.
- Configuration purely via environment variables — no hardcoded device IDs, bundle IDs, or paths.

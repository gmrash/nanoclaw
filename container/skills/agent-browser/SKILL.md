---
name: agent-browser
description: Browse the web for any task — research topics, read articles, interact with web apps, fill forms, take screenshots, extract data, and test web pages. Use whenever a browser would be useful, not just when the user explicitly asks.
allowed-tools: Bash(agent-browser:*)
---

# Browser Automation with agent-browser

## Quick start

```bash
agent-browser open <url>        # Navigate to page
agent-browser snapshot -i       # Get interactive elements with refs
agent-browser click @e1         # Click element by ref
agent-browser fill @e2 "text"   # Fill input by ref
agent-browser close             # Close browser
```

## Core workflow

1. Navigate: `agent-browser open <url>`
2. Snapshot: `agent-browser snapshot -i` (returns elements with refs like `@e1`, `@e2`)
3. Interact using refs from the snapshot
4. Re-snapshot after navigation or significant DOM changes

## Apple / iCloud auth guardrails

For Apple login, iCloud, and Find My tasks:
- First try `agent-browser state load /workspace/group/apple-auth.json` before a fresh Apple login.
- Use the `send_message` tool for every major status: opening login, waiting for 2FA, code entered, login succeeded, blocked.
- Stay inside the browser flow. Do not call private Apple APIs like `fmipmobile.icloud.com` directly.
- Do not write scripts to inspect or replay cookies, tokens, or local storage.
- Do not use screenshot OCR or `Read` on full screenshots as the main Apple login method when URL, snapshot, and regular controls are enough.
- When starting from a Find My shared link, stay in the same browser context and click `Use Apple Account`. Do not extract a raw `idmsa.apple.com/appleauth/auth/authorize/signin` URL and open it as a top-level page.
- `account.apple.com` by itself is not success. Success means the shared Find My page on `find.apple.com` is authenticated and shows the item data.
- When Apple requests 2FA, ask the user for the 6-digit code with `send_message` and wait.
- After receiving a code, only enter the code, wait for the next screen, and report the outcome with `send_message`.
- If Apple requests another code, ask for another code. Do not start alternate login strategies.
- After login succeeds, save state to `/workspace/group/apple-auth.json` and open the target Find My link once. Do not restart email/password flow in the same run.
- For each Apple page, use at most two interaction strategies. If still blocked, send the exact blocker and stop.
- If Find My still shows a login iframe after successful Apple login, report the blocker and stop. Do not debug iframe internals, cookies, or storage loops.
- If the browser step takes more than 20 seconds, send a short status update with `send_message` instead of going silent.
- If login succeeds, save state and reuse it on the next attempt.

## Commands

### Navigation

```bash
agent-browser open <url>      # Navigate to URL
agent-browser back            # Go back
agent-browser forward         # Go forward
agent-browser reload          # Reload page
agent-browser close           # Close browser
```

### Snapshot (page analysis)

```bash
agent-browser snapshot            # Full accessibility tree
agent-browser snapshot -i         # Interactive elements only (recommended)
agent-browser snapshot -c         # Compact output
agent-browser snapshot -d 3       # Limit depth to 3
agent-browser snapshot -s "#main" # Scope to CSS selector
```

### Interactions (use @refs from snapshot)

```bash
agent-browser click @e1           # Click
agent-browser dblclick @e1        # Double-click
agent-browser fill @e2 "text"     # Clear and type
agent-browser type @e2 "text"     # Type without clearing
agent-browser press Enter         # Press key
agent-browser hover @e1           # Hover
agent-browser check @e1           # Check checkbox
agent-browser uncheck @e1         # Uncheck checkbox
agent-browser select @e1 "value"  # Select dropdown option
agent-browser scroll down 500     # Scroll page
agent-browser upload @e1 file.pdf # Upload files
```

### Get information

```bash
agent-browser get text @e1        # Get element text
agent-browser get html @e1        # Get innerHTML
agent-browser get value @e1       # Get input value
agent-browser get attr @e1 href   # Get attribute
agent-browser get title           # Get page title
agent-browser get url             # Get current URL
agent-browser get count ".item"   # Count matching elements
```

### Screenshots & PDF

```bash
agent-browser screenshot          # Save to temp directory
agent-browser screenshot path.png # Save to specific path
agent-browser screenshot --full   # Full page
agent-browser pdf output.pdf      # Save as PDF
```

### Wait

```bash
agent-browser wait @e1                     # Wait for element
agent-browser wait 2000                    # Wait milliseconds
agent-browser wait --text "Success"        # Wait for text
agent-browser wait --url "**/dashboard"    # Wait for URL pattern
agent-browser wait --load networkidle      # Wait for network idle
```

### Semantic locators (alternative to refs)

```bash
agent-browser find role button click --name "Submit"
agent-browser find text "Sign In" click
agent-browser find label "Email" fill "user@test.com"
agent-browser find placeholder "Search" type "query"
```

### Authentication with saved state

```bash
# Login once
agent-browser open https://app.example.com/login
agent-browser snapshot -i
agent-browser fill @e1 "username"
agent-browser fill @e2 "password"
agent-browser click @e3
agent-browser wait --url "**/dashboard"
agent-browser state save auth.json

# Later: load saved state
agent-browser state load auth.json
agent-browser open https://app.example.com/dashboard
```

### Cookies & Storage

```bash
agent-browser cookies                     # Get all cookies
agent-browser cookies set name value      # Set cookie
agent-browser cookies clear               # Clear cookies
agent-browser storage local               # Get localStorage
agent-browser storage local set k v       # Set value
```

### JavaScript

```bash
agent-browser eval "document.title"   # Run JavaScript
```

## Example: Form submission

```bash
agent-browser open https://example.com/form
agent-browser snapshot -i
# Output shows: textbox "Email" [ref=e1], textbox "Password" [ref=e2], button "Submit" [ref=e3]

agent-browser fill @e1 "user@example.com"
agent-browser fill @e2 "password123"
agent-browser click @e3
agent-browser wait --load networkidle
agent-browser snapshot -i  # Check result
```

## Example: Data extraction

```bash
agent-browser open https://example.com/products
agent-browser snapshot -i
agent-browser get text @e1  # Get product title
agent-browser get attr @e2 href  # Get link URL
agent-browser screenshot products.png
```

# Appointment Availability Monitor

A Node.js automation tool that monitors appointment availability on a dynamic booking website and sends real-time Telegram notifications when slots become available.

## Motivation

Road test appointments can appear unexpectedly due to cancellations, making it difficult to secure a convenient time. Manually checking the booking system is time-consuming and inefficient.

I built this tool to automate monitoring while keeping the user in control of booking manually.

## Features

- Automated browser interaction using Playwright
- Secure authentication using environment variables
- Configurable polling intervals
- Real-time Telegram notifications
- Error handling with debug screenshots
- Works with dynamic, JavaScript-rendered pages

## Tech Stack

- Node.js
- Playwright
- Telegram Bot API
- dotenv

## Example Notification

<p align="center">
  <img src="docs/example-notification.png" width="350"/>
</p>

## How It Works

1. Opens the ICBC booking website
2. Logs in using user-provided credentials
3. Navigates to the "By office" search
4. Searches for a specific location (e.g., Burnaby driver licensing)
5. Checks if appointment slots are available
6. Sends a Telegram notification if availability is detected
7. Repeats every few minutes

## Setup

### 1. Install dependencies

```bash
npm install
npx playwright install
```

### 2. Create .env file

Copy from .env.example and fill in your values:
```
ICBC_LAST_NAME=your_last_name
ICBC_DL_NUMBER=your_driver_license_number
ICBC_KEYWORD=your_keyword
TELEGRAM_BOT_TOKEN=your_token
TELEGRAM_CHAT_ID=your_chat_id
CHECK_EVERY_MINUTES=5
```

### 3. Run the watcher

```
npm start
```

## Responsible Use

This tool is intended for personal monitoring only.
- It does not automatically book appointments
- It does not bypass authentication or platform protections
- Users are responsible for complying with the terms of service of any website they use it with

## Future Improvements

- Extract and display exact appointment date/time
- Support multiple locations
- Prevent duplicate notifications
- Add email/SMS notification options
- Improve UI or CLI configuration

## Outcome

This tool was successfully used to detect an available appointment slot and complete a booking in real-time.
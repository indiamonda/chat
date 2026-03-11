import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({
    headless: true
  });
  
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1920, height: 1080 });
  
  console.log('Navigating to https://jchat.fly.dev...');
  await page.goto('https://jchat.fly.dev', { 
    waitUntil: 'networkidle',
    timeout: 30000 
  });
  
  // Wait for page to load
  await page.waitForTimeout(2000);
  
  // Click sign up
  console.log('Clicking sign up...');
  await page.click('text=sign up');
  await page.waitForTimeout(2000);
  
  // Fill out the signup form with more specific selectors
  console.log('Filling signup form...');
  const timestamp = Date.now();
  
  // Get all input fields on the page
  const inputs = await page.locator('input').all();
  console.log(`Found ${inputs.length} input fields`);
  
  // Fill them in order
  if (inputs.length >= 5) {
    await inputs[0].fill('TestUser' + timestamp); // Display name
    await inputs[1].fill('testuser' + timestamp); // Username
    await inputs[2].fill(`test${timestamp}@example.com`); // Email
    await inputs[3].fill('TestPassword123!'); // Password
    await inputs[4].fill('TestPassword123!'); // Confirm password
    
    // Submit the form
    console.log('Submitting signup form...');
    await page.click('button:has-text("Sign up")');
    
    // Wait for navigation to chat page
    await page.waitForTimeout(5000);
  }
  
  // Take screenshot of the chat interface
  console.log('Taking screenshot of chat interface...');
  await page.screenshot({ 
    path: 'jchat-chat-interface.png',
    fullPage: true 
  });
  
  // Try to find the message input and send a long message to test overflow
  const textareas = await page.locator('textarea').all();
  const textInputs = await page.locator('input[type="text"]:not([name*="login"]):not([name*="username"]):not([name*="email"])').all();
  
  let messageInput = null;
  if (textareas.length > 0) {
    messageInput = textareas[textareas.length - 1];
  } else if (textInputs.length > 0) {
    messageInput = textInputs[textInputs.length - 1];
  }
  
  if (messageInput && await messageInput.isVisible().catch(() => false)) {
    console.log('Sending test messages...');
    
    // Send a very long message to test overflow
    const longMessage = 'This is a very long message to test text overflow in the chat message boxes. It should wrap properly within the message bubble without extending beyond its boundaries. If there is a text overflow issue, this message will demonstrate it clearly by extending beyond the chat bubble boundaries.';
    await messageInput.fill(longMessage);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1000);
    
    // Send another long message with no spaces
    const longMessageNoSpaces = 'ThisIsAVeryLongMessageWithNoSpacesToTestTextOverflowInTheChatMessageBoxesItShouldWrapProperlyWithinTheMessageBubbleWithoutExtendingBeyondItsBoundaries';
    await messageInput.fill(longMessageNoSpaces);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1000);
    
    // Take screenshot after sending messages
    console.log('Taking screenshot with messages...');
    await page.screenshot({ 
      path: 'jchat-with-messages.png',
      fullPage: true 
    });
  }
  
  console.log('Screenshots saved');
  
  await browser.close();
})();

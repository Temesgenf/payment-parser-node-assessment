const validator = require('@app-core/validator');
const { throwAppError, ERROR_CODE } = require('@app-core/errors');
const PaymentMessages = require('@app/messages/payment');

/**
 * ============================================================
 * CONFIGURATION & CONSTANTS
 * ============================================================
 */

// Input validation schema
const INPUT_SCHEMA = `root {
  accounts[] {
    id string
    balance number
    currency string
  }
  instruction string
}`;

const parsedSchema = validator.parse(INPUT_SCHEMA);

// Supported currencies (case-insensitive during parsing, but returned as uppercase)
const SUPPORTED_CURRENCIES = ['NGN', 'USD', 'GBP', 'GHS'];

// Application status codes for different error scenarios
const STATUS_CODES = {
  // Amount errors
  INVALID_AMOUNT: 'AM01',

  // Currency errors
  CURRENCY_MISMATCH: 'CU01',
  UNSUPPORTED_CURRENCY: 'CU02',

  // Account errors
  INSUFFICIENT_FUNDS: 'AC01',
  SAME_ACCOUNT: 'AC02',
  ACCOUNT_NOT_FOUND: 'AC03',
  INVALID_ACCOUNT_ID: 'AC04',

  // Date errors
  INVALID_DATE: 'DT01',

  // Syntax errors
  MISSING_KEYWORD: 'SY01',
  INVALID_KEYWORD_ORDER: 'SY02',
  MALFORMED: 'SY03',

  // Success codes
  SUCCESS: 'AP00',
  PENDING: 'AP02',
};

/**
 * ============================================================
 * HELPER FUNCTIONS - STRING MANIPULATION
 * ============================================================
 */

/**
 * Normalize whitespace in a string (trim and collapse multiple spaces)
 * @param {string} str - Input string
 * @returns {string} Normalized string
 */
function normalizeWhitespace(str) {
  if (typeof str !== 'string') return '';

  // Trim leading/trailing spaces
  const result = str.trim();

  // Replace multiple spaces with single space
  let normalized = '';
  let prevWasSpace = false;

  for (let i = 0; i < result.length; i++) {
    const char = result[i];
    const isSpace = char === ' ' || char === '\t' || char === '\n' || char === '\r';

    if (isSpace) {
      if (!prevWasSpace) {
        normalized += ' ';
        prevWasSpace = true;
      }
    } else {
      normalized += char;
      prevWasSpace = false;
    }
  }

  return normalized;
}

/**
 * Convert string to uppercase for case-insensitive comparison
 * @param {string} str - Input string
 * @returns {string} Uppercase string
 */
function toUpper(str) {
  return String(str || '').toUpperCase();
}

/**
 * Find the position of a keyword in text (case-insensitive, whole word match)
 * @param {string} text - Text to search in
 * @param {string} keyword - Keyword to find
 * @param {number} startPos - Starting position
 * @returns {number} Position of keyword or -1 if not found
 */
function findKeywordPosition(text, keyword, startPos = 0) {
  const textUpper = toUpper(text);
  const keywordUpper = toUpper(keyword);

  let pos = startPos;

  while (pos < text.length) {
    const foundPos = textUpper.indexOf(keywordUpper, pos);

    if (foundPos === -1) {
      return -1; // Not found
    }

    // Check if it's a whole word (not part of another word)
    const isStartOfText = foundPos === 0;
    const isEndOfText = foundPos + keywordUpper.length === text.length;
    const hasSpaceBefore = !isStartOfText && text[foundPos - 1] === ' ';
    const hasSpaceAfter = !isEndOfText && text[foundPos + keywordUpper.length] === ' ';

    const isWholeWord = (isStartOfText || hasSpaceBefore) && (isEndOfText || hasSpaceAfter);

    if (isWholeWord) {
      return foundPos;
    }

    // Continue searching
    pos = foundPos + 1;
  }

  return -1;
}
/**
 * Extract the next word from text starting at position
 * @param {string} text - Text to extract from
 * @param {number} startPos - Starting position
 * @returns {string} Extracted word
 */
function extractNextWord(text, startPos) {
  let pos = startPos;

  // Skip leading spaces
  while (pos < text.length && text[pos] === ' ') {
    pos++;
  }

  const wordStart = pos;

  // Extract until space or end
  while (pos < text.length && text[pos] !== ' ') {
    pos++;
  }

  return text.substring(wordStart, pos).trim();
}

/**
 * ============================================================
 * VALIDATION FUNCTIONS
 * ============================================================
 */

/**
 * Validate account ID format (letters, numbers, hyphens, periods, @ only)
 * @param {string} accountId - Account ID to validate
 * @returns {boolean} True if valid
 */
function isValidAccountId(accountId) {
  if (typeof accountId !== 'string' || accountId.length === 0) {
    return false;
  }

  for (let i = 0; i < accountId.length; i++) {
    const char = accountId[i];
    const code = accountId.charCodeAt(i);

    const isLetter = (code >= 65 && code <= 90) || (code >= 97 && code <= 122); // A-Z, a-z
    const isDigit = code >= 48 && code <= 57; // 0-9
    const isSpecial = char === '-' || char === '.' || char === '@';

    if (!isLetter && !isDigit && !isSpecial) {
      return false;
    }
  }

  return true;
}

/**
 * Validate date format YYYY-MM-DD
 * @param {string} dateStr - Date string to validate
 * @returns {boolean} True if valid
 */
function isValidDateFormat(dateStr) {
  if (typeof dateStr !== 'string' || dateStr.length !== 10) {
    return false;
  }

  // Check separators
  if (dateStr[4] !== '-' || dateStr[7] !== '-') {
    return false;
  }

  // Extract parts
  const yearStr = dateStr.substring(0, 4);
  const monthStr = dateStr.substring(5, 7);
  const dayStr = dateStr.substring(8, 10);

  // Validate each part is numeric
  for (let i = 0; i < yearStr.length; i++) {
    if (yearStr[i] < '0' || yearStr[i] > '9') return false;
  }
  for (let i = 0; i < monthStr.length; i++) {
    if (monthStr[i] < '0' || monthStr[i] > '9') return false;
  }
  for (let i = 0; i < dayStr.length; i++) {
    if (dayStr[i] < '0' || dayStr[i] > '9') return false;
  }

  // Validate ranges
  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);
  const day = parseInt(dayStr, 10);

  if (year < 1900 || year > 9999) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;

  return true;
}

/**
 * Check if date is in the future (UTC comparison, date portion only)
 * @param {string} dateStr - Date string in YYYY-MM-DD format
 * @returns {boolean} True if date is in the future
 */
function isFutureDate(dateStr) {
  // Get today's date in UTC
  const now = new Date();
  const todayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  // Parse instruction date
  const parts = dateStr.split('-');
  const year = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10) - 1; // Month is 0-indexed in Date
  const day = parseInt(parts[2], 10);

  const instructionDate = new Date(Date.UTC(year, month, day));

  return instructionDate > todayUTC;
}

/**
 * Validate amount (must be positive integer, no decimals, no negatives)
 * @param {string} amountStr - Amount as string
 * @returns {object} { isValid: boolean, value: number|null }
 */
function validateAmount(amountStr) {
  if (typeof amountStr !== 'string' || amountStr.length === 0) {
    return { isValid: false, value: null };
  }

  // Check for negative sign
  if (amountStr.indexOf('-') !== -1) {
    return { isValid: false, value: null };
  }

  // Check for decimal point
  if (amountStr.indexOf('.') !== -1) {
    return { isValid: false, value: null };
  }

  // Check all characters are digits
  for (let i = 0; i < amountStr.length; i++) {
    const char = amountStr[i];
    if (char < '0' || char > '9') {
      return { isValid: false, value: null };
    }
  }

  // Convert to number
  const value = parseInt(amountStr, 10);

  if (Number.isNaN(value) || value <= 0) {
    return { isValid: false, value: null };
  }

  return { isValid: true, value };
}

/**
 * ============================================================
 * PARSING FUNCTIONS
 * ============================================================
 */

/**
 * Parse DEBIT format instruction
 * Format: DEBIT [amount] [currency] FROM ACCOUNT [id] FOR CREDIT TO ACCOUNT [id] [ON [date]]
 * @param {string} instruction - Instruction string
 * @returns {object|null} Parsed data or null if invalid
 */
function parseDebitInstruction(instruction) {
  const result = {
    type: 'DEBIT',
    amount: null,
    currency: null,
    debitAccountId: null,
    creditAccountId: null,
    executeBy: null,
  };

  // Find DEBIT keyword (must be at start)
  const debitPos = findKeywordPosition(instruction, 'DEBIT', 0);
  if (debitPos !== 0) {
    return null; // DEBIT must be first word
  }

  // Extract everything after DEBIT
  let remaining = instruction.substring(5).trim();
  if (remaining.length === 0) return null;

  // Extract amount (first word after DEBIT)
  const amountStr = extractNextWord(remaining, 0);
  if (!amountStr) return null;
  result.amount = amountStr;
  remaining = remaining.substring(amountStr.length).trim();

  // Extract currency (second word after DEBIT)
  const currencyStr = extractNextWord(remaining, 0);
  if (!currencyStr) return null;
  result.currency = currencyStr;
  remaining = remaining.substring(currencyStr.length).trim();

  // Find FROM keyword
  const fromPos = findKeywordPosition(remaining, 'FROM', 0);
  if (fromPos === -1) return null;
  remaining = remaining.substring(fromPos + 4).trim();

  // Find ACCOUNT keyword after FROM
  const accountPos1 = findKeywordPosition(remaining, 'ACCOUNT', 0);
  if (accountPos1 === -1) return null;
  remaining = remaining.substring(accountPos1 + 7).trim();

  // Extract debit account ID
  const debitAccountId = extractNextWord(remaining, 0);
  if (!debitAccountId) return null;
  result.debitAccountId = debitAccountId;
  remaining = remaining.substring(debitAccountId.length).trim();

  // Find FOR keyword
  const forPos = findKeywordPosition(remaining, 'FOR', 0);
  if (forPos === -1) return null;
  remaining = remaining.substring(forPos + 3).trim();

  // Find CREDIT keyword
  const creditPos = findKeywordPosition(remaining, 'CREDIT', 0);
  if (creditPos === -1) return null;
  remaining = remaining.substring(creditPos + 6).trim();

  // Find TO keyword
  const toPos = findKeywordPosition(remaining, 'TO', 0);
  if (toPos === -1) return null;
  remaining = remaining.substring(toPos + 2).trim();

  // Find ACCOUNT keyword after TO
  const accountPos2 = findKeywordPosition(remaining, 'ACCOUNT', 0);
  if (accountPos2 === -1) return null;
  remaining = remaining.substring(accountPos2 + 7).trim();

  // Extract credit account ID
  const creditAccountId = extractNextWord(remaining, 0);
  if (!creditAccountId) return null;
  result.creditAccountId = creditAccountId;
  remaining = remaining.substring(creditAccountId.length).trim();

  // Check for optional ON keyword
  if (remaining.length > 0) {
    const onPos = findKeywordPosition(remaining, 'ON', 0);
    if (onPos !== -1) {
      remaining = remaining.substring(onPos + 2).trim();
      const dateStr = extractNextWord(remaining, 0);
      if (dateStr) {
        result.executeBy = dateStr;
      }
    }
  }

  return result;
}

/**
 * Parse CREDIT format instruction
 * Format: CREDIT [amount] [currency] TO ACCOUNT [id] FOR DEBIT FROM ACCOUNT [id] [ON [date]]
 * @param {string} instruction - Instruction string
 * @returns {object|null} Parsed data or null if invalid
 */
function parseCreditInstruction(instruction) {
  const result = {
    type: 'CREDIT',
    amount: null,
    currency: null,
    debitAccountId: null,
    creditAccountId: null,
    executeBy: null,
  };

  // Find CREDIT keyword (must be at start)
  const creditPos = findKeywordPosition(instruction, 'CREDIT', 0);
  if (creditPos !== 0) {
    return null; // CREDIT must be first word
  }

  // Extract everything after CREDIT
  let remaining = instruction.substring(6).trim();
  if (remaining.length === 0) return null;

  // Extract amount
  const amountStr = extractNextWord(remaining, 0);
  if (!amountStr) return null;
  result.amount = amountStr;
  remaining = remaining.substring(amountStr.length).trim();

  // Extract currency
  const currencyStr = extractNextWord(remaining, 0);
  if (!currencyStr) return null;
  result.currency = currencyStr;
  remaining = remaining.substring(currencyStr.length).trim();

  // Find TO keyword
  const toPos = findKeywordPosition(remaining, 'TO', 0);
  if (toPos === -1) return null;
  remaining = remaining.substring(toPos + 2).trim();

  // Find ACCOUNT keyword after TO
  const accountPos1 = findKeywordPosition(remaining, 'ACCOUNT', 0);
  if (accountPos1 === -1) return null;
  remaining = remaining.substring(accountPos1 + 7).trim();

  // Extract credit account ID
  const creditAccountId = extractNextWord(remaining, 0);
  if (!creditAccountId) return null;
  result.creditAccountId = creditAccountId;
  remaining = remaining.substring(creditAccountId.length).trim();

  // Find FOR keyword
  const forPos = findKeywordPosition(remaining, 'FOR', 0);
  if (forPos === -1) return null;
  remaining = remaining.substring(forPos + 3).trim();

  // Find DEBIT keyword
  const debitPos = findKeywordPosition(remaining, 'DEBIT', 0);
  if (debitPos === -1) return null;
  remaining = remaining.substring(debitPos + 5).trim();

  // Find FROM keyword
  const fromPos = findKeywordPosition(remaining, 'FROM', 0);
  if (fromPos === -1) return null;
  remaining = remaining.substring(fromPos + 4).trim();

  // Find ACCOUNT keyword after FROM
  const accountPos2 = findKeywordPosition(remaining, 'ACCOUNT', 0);
  if (accountPos2 === -1) return null;
  remaining = remaining.substring(accountPos2 + 7).trim();

  // Extract debit account ID
  const debitAccountId = extractNextWord(remaining, 0);
  if (!debitAccountId) return null;
  result.debitAccountId = debitAccountId;
  remaining = remaining.substring(debitAccountId.length).trim();

  // Check for optional ON keyword
  if (remaining.length > 0) {
    const onPos = findKeywordPosition(remaining, 'ON', 0);
    if (onPos !== -1) {
      remaining = remaining.substring(onPos + 2).trim();
      const dateStr = extractNextWord(remaining, 0);
      if (dateStr) {
        result.executeBy = dateStr;
      }
    }
  }

  return result;
}

/**
 * Create error response for unparseable instructions
 * @param {string} reason - Error reason
 * @param {string} code - Status code
 * @returns {object} Error response
 */
function createMalformedResponse(reason, code) {
  return {
    type: null,
    amount: null,
    currency: null,
    debit_account: null,
    credit_account: null,
    execute_by: null,
    status: 'failed',
    status_reason: reason,
    status_code: code,
    accounts: [],
  };
}

/**
 * Find account in accounts array by ID (case-sensitive)
 * @param {array} accounts - Array of account objects
 * @param {string} accountId - Account ID to find
 * @returns {object|null} Account object or null
 */
function findAccountById(accounts, accountId) {
  for (let i = 0; i < accounts.length; i++) {
    if (accounts[i].id === accountId) {
      return accounts[i];
    }
  }
  return null;
}

/**
 * Build parsed instruction data for error context
 * @param {object} parsed - Parsed instruction
 * @returns {object} Instruction data for context
 */
function buildParsedData(parsed) {
  return {
    type: parsed.type || null,
    amount: parsed.amount || null,
    currency: parsed.currency || null,
    debit_account: parsed.debitAccountId || null,
    credit_account: parsed.creditAccountId || null,
    execute_by: parsed.executeBy || null,
  };
}

/**
 * ============================================================
 * MAIN PARSING FUNCTION
 * ============================================================
 */
/**
 * Parse and validate payment instruction
 * @param {object} serviceData - Input data containing accounts and instruction
 * @returns {Promise<object>} Parsed instruction response
 */
async function parseInstruction(serviceData) {
  // Validate input schema
  const data = validator.validate(serviceData, parsedSchema);
  const { accounts, instruction } = data;

  // Normalize instruction
  const normalizedInstruction = normalizeWhitespace(instruction);

  // Try parsing as DEBIT format
  let parsed = parseDebitInstruction(normalizedInstruction);

  // If not DEBIT, try CREDIT format
  if (!parsed) {
    parsed = parseCreditInstruction(normalizedInstruction);
  }

  // If completely unparseable
  if (!parsed) {
    return createMalformedResponse(PaymentMessages.MALFORMED_INSTRUCTION, STATUS_CODES.MALFORMED);
  }

  // Validate amount
  const amountValidation = validateAmount(parsed.amount);
  if (!amountValidation.isValid) {
    throwAppError(PaymentMessages.INVALID_AMOUNT, ERROR_CODE.INVLDDATA, {
      context: {
        status_code: STATUS_CODES.INVALID_AMOUNT,
        parsed: buildParsedData(parsed),
      },
    });
  }
  parsed.amount = amountValidation.value;

  // Validate and normalize currency
  const currencyUpper = toUpper(parsed.currency);
  let isCurrencySupported = false;
  for (let i = 0; i < SUPPORTED_CURRENCIES.length; i++) {
    if (currencyUpper === SUPPORTED_CURRENCIES[i]) {
      isCurrencySupported = true;
      break;
    }
  }

  // Update parsed currency to uppercase
  parsed.currency = currencyUpper;

  // Validate account ID formats
  if (!isValidAccountId(parsed.debitAccountId)) {
    throwAppError(PaymentMessages.INVALID_ACCOUNT_ID, ERROR_CODE.INVLDDATA, {
      context: {
        status_code: STATUS_CODES.INVALID_ACCOUNT_ID,
        parsed: buildParsedData(parsed),
      },
    });
  }

  if (!isValidAccountId(parsed.creditAccountId)) {
    throwAppError(PaymentMessages.INVALID_ACCOUNT_ID, ERROR_CODE.INVLDDATA, {
      context: {
        status_code: STATUS_CODES.INVALID_ACCOUNT_ID,
        parsed: buildParsedData(parsed),
      },
    });
  }

  // Validate accounts are different
  if (parsed.debitAccountId === parsed.creditAccountId) {
    throwAppError(PaymentMessages.SAME_ACCOUNT_ERROR, ERROR_CODE.INVLDDATA, {
      context: {
        status_code: STATUS_CODES.SAME_ACCOUNT,
        parsed: buildParsedData(parsed),
      },
    });
  }

  // Find accounts
  const debitAccount = findAccountById(accounts, parsed.debitAccountId);
  const creditAccount = findAccountById(accounts, parsed.creditAccountId);

  if (!debitAccount) {
    throwAppError(PaymentMessages.ACCOUNT_NOT_FOUND, ERROR_CODE.NOTFOUND, {
      context: {
        status_code: STATUS_CODES.ACCOUNT_NOT_FOUND,
        parsed: buildParsedData(parsed),
      },
    });
  }

  if (!creditAccount) {
    throwAppError(PaymentMessages.ACCOUNT_NOT_FOUND, ERROR_CODE.NOTFOUND, {
      context: {
        status_code: STATUS_CODES.ACCOUNT_NOT_FOUND,
        parsed: buildParsedData(parsed),
      },
    });
  }

  // Build account response objects (do this early so we can include in all subsequent errors)
  const accountsInOriginalOrder = [];
  for (let i = 0; i < accounts.length; i++) {
    const acc = accounts[i];
    if (acc.id === parsed.debitAccountId || acc.id === parsed.creditAccountId) {
      accountsInOriginalOrder.push({
        id: acc.id,
        balance: acc.balance,
        balance_before: acc.balance,
        currency: toUpper(acc.currency),
      });
    }
  }

  // Now validate currency support (after we have accounts)
  if (!isCurrencySupported) {
    throwAppError(PaymentMessages.UNSUPPORTED_CURRENCY, ERROR_CODE.INVLDDATA, {
      context: {
        status_code: STATUS_CODES.UNSUPPORTED_CURRENCY,
        parsed: buildParsedData(parsed),
        accounts: accountsInOriginalOrder,
      },
    });
  }

  // Validate currency match between accounts
  const debitCurrency = toUpper(debitAccount.currency);
  const creditCurrency = toUpper(creditAccount.currency);

  if (debitCurrency !== creditCurrency) {
    throwAppError(PaymentMessages.CURRENCY_MISMATCH, ERROR_CODE.INVLDDATA, {
      context: {
        status_code: STATUS_CODES.CURRENCY_MISMATCH,
        parsed: buildParsedData(parsed),
        accounts: accountsInOriginalOrder,
      },
    });
  }

  if (debitCurrency !== parsed.currency) {
    throwAppError(PaymentMessages.CURRENCY_MISMATCH, ERROR_CODE.INVLDDATA, {
      context: {
        status_code: STATUS_CODES.CURRENCY_MISMATCH,
        parsed: buildParsedData(parsed),
        accounts: accountsInOriginalOrder,
      },
    });
  }

  // Validate date if provided
  let shouldExecuteNow = true;
  if (parsed.executeBy) {
    if (!isValidDateFormat(parsed.executeBy)) {
      throwAppError(PaymentMessages.INVALID_DATE_FORMAT, ERROR_CODE.INVLDDATA, {
        context: {
          status_code: STATUS_CODES.INVALID_DATE,
          parsed: buildParsedData(parsed),
          accounts: accountsInOriginalOrder,
        },
      });
    }

    shouldExecuteNow = !isFutureDate(parsed.executeBy);
  }

  // Check sufficient funds (only if executing immediately)
  if (shouldExecuteNow && debitAccount.balance < parsed.amount) {
    throwAppError(PaymentMessages.INSUFFICIENT_FUNDS, ERROR_CODE.INVLDDATA, {
      context: {
        status_code: STATUS_CODES.INSUFFICIENT_FUNDS,
        parsed: buildParsedData(parsed),
        accounts: accountsInOriginalOrder,
      },
    });
  }

  // Update balances if executing immediately
  if (shouldExecuteNow) {
    for (let i = 0; i < accountsInOriginalOrder.length; i++) {
      const acc = accountsInOriginalOrder[i];
      if (acc.id === parsed.debitAccountId) {
        acc.balance -= parsed.amount;
      } else if (acc.id === parsed.creditAccountId) {
        acc.balance += parsed.amount;
      }
    }
  }

  // Build successful response
  return {
    type: parsed.type,
    amount: parsed.amount,
    currency: parsed.currency,
    debit_account: parsed.debitAccountId,
    credit_account: parsed.creditAccountId,
    execute_by: parsed.executeBy || null,
    status: shouldExecuteNow ? 'successful' : 'pending',
    status_reason: shouldExecuteNow
      ? PaymentMessages.TRANSACTION_SUCCESSFUL
      : PaymentMessages.TRANSACTION_PENDING,
    status_code: shouldExecuteNow ? STATUS_CODES.SUCCESS : STATUS_CODES.PENDING,
    accounts: accountsInOriginalOrder,
  };
}

module.exports = parseInstruction;

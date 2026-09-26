// ============================================================
// MUFASER-X — PRIVATE PAIRING + SESSION SERVER
// WhatsApp Multi-Device Bot by ROMA-TECH
//
// PURPOSE: 
// - Generate WhatsApp pairing codes
// - Generate QR codes
// - Wait for WhatsApp connection
// - Generate MUFASER-X Session ID
// - Send Session ID to Message Yourself
//
// IMPORTANT:
// This server does NOT contain the bot commands.
// ============================================================

require('dotenv').config();

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');

const pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');
const express = require('express');
const zlib = require('zlib');

const commands = new Map();

const commandsDir =
  path.join(
    __dirname,
    'commands'
  );

if (
  fs.existsSync(
    commandsDir
  )
) {

  for (
    const file of fs.readdirSync(
      commandsDir
    )
  ) {

    if (
      !file.endsWith('.js')
    ) {
      continue;
    }

    try {

      const command =
        require(
          path.join(
            commandsDir,
            file
          )
        );

      if (
        !command ||
        !command.name ||
        typeof command.execute !== 'function'
      ) {

        console.log(
          `[Commands] ⚠️ Skipped invalid command: ${file}`
        );

        continue;
      }

      commands.set(
        String(
          command.name
        ).toLowerCase(),
        command
      );

      if (
        Array.isArray(
          command.aliases
        )
      ) {

        for (
          const alias of command.aliases
        ) {

          commands.set(
            String(
              alias
            ).toLowerCase(),
            command
          );

        }

      }

      console.log(
        `[Commands] ✅ Loaded: .${command.name}`
      );

    } catch (error) {

      console.error(
        `[Commands] ❌ Failed to load ${file}:`,
        error.message
      );

    }

  }

} else {

  console.log(
    '[Commands] ⚠️ commands folder not found.'
  );

}
// ============================================================
// CONFIG
// ============================================================

const config = require('./config.js');

// ============================================================
// LOGGER
// ============================================================

const logger = pino({
  level: 'silent'
});

// ============================================================
// ACCOUNT STORAGE
// ============================================================

const accounts = new Map();

// ============================================================
// PHONE NORMALIZER
// ============================================================

function normalizePhone(phone) {
  return String(phone || '')
    .replace(/\D/g, '');
}

// ============================================================
// GET / CREATE ACCOUNT
// ============================================================

function getAccount(phoneNumber) {

  const phone =
    normalizePhone(phoneNumber);

  if (!phone) return null;

  if (!accounts.has(phone)) {

    accounts.set(phone, {

      phone,

      // Connection
      status: 'idle',
      isConnecting: false,
      sock: null,

      // Pairing
      pairingCode: null,
      qrDataUrl: null,

      // Session
      sessionDir: path.join(
        __dirname,
        'sessions',
        phone
      ),

      credsPath: path.join(
        __dirname,
        'sessions',
        phone,
        'creds.json'
      ),

      sessionSentFlag: path.join(
        __dirname,
        'sessions',
        phone,
        '.session_sent'
      ),

      // Prevent automatic reconnect after
      // Session ID generation.
      stopAfterSession: false
    });
  }

  return accounts.get(phone);
}

// ============================================================
// COLLECT COMPLETE BAILEYS SESSION
// ============================================================

function collectSessionFiles(
  dir,
  baseDir = dir
) {

  const files = [];

  if (!fs.existsSync(dir)) {
    return files;
  }

  for (
    const entry of fs.readdirSync(
      dir,
      { withFileTypes: true }
    )
  ) {

    const fullPath =
      path.join(
        dir,
        entry.name
      );

    if (entry.isDirectory()) {

      files.push(
        ...collectSessionFiles(
          fullPath,
          baseDir
        )
      );

    } else if (entry.isFile()) {

      files.push({

        path:
          path
            .relative(
              baseDir,
              fullPath
            )
            .replace(/\\/g, '/'),

        data:
          fs
            .readFileSync(fullPath)
            .toString('base64')
      });
    }
  }

  return files;
}

// ============================================================
// CREATE MUFASER-X SESSION ID
// ============================================================

function createSessionId(account) {

  if (
    !account ||
    !account.sessionDir
  ) {
    throw new Error(
      'Account session directory is missing.'
    );
  }

  if (
    !fs.existsSync(
      account.sessionDir
    )
  ) {
    throw new Error(
      'Session directory does not exist.'
    );
  }

  const files =
    collectSessionFiles(
      account.sessionDir
    );

  if (!files.length) {

    throw new Error(
      'No WhatsApp authentication files found.'
    );
  }

  const payload = {

    format:
      'MUFASER-X-SESSION',

    version:
      1,

    phone:
      account.phone,

    files
  };

  const json =
    JSON.stringify(payload);

  const compressed =
    zlib.gzipSync(
      Buffer.from(
        json,
        'utf8'
      )
    );

  return (
    'MUFASER-X:~' +
    compressed.toString('base64')
  );
}

// ============================================================
// CLEAR SESSION
// ============================================================

function clearAccountSession(account) {

  if (!account) return;

  try {

    if (
      fs.existsSync(
        account.sessionDir
      )
    ) {

      fs.rmSync(
        account.sessionDir,
        {
          recursive: true,
          force: true
        }
      );
    }

    account.pairingCode = null;
    account.qrDataUrl = null;
    account.sock = null;
    account.status = 'session_not_found';
    account.isConnecting = false;
    account.stopAfterSession = false;

    console.log(
      `[Session:${account.phone}] 🗑️ Session cleared.`
    );

  } catch (error) {

    console.error(
      `[Session:${account.phone}] ❌ Failed to clear session:`,
      error.message
    );
  }
}

// ============================================================
// WAIT HELPER
// ============================================================

function waitFor(
  condition,
  timeoutMs = 30000,
  intervalMs = 250
) {

  return new Promise(resolve => {

    const start =
      Date.now();

    const interval =
      setInterval(() => {

        try {

          const value =
            condition();

          if (value) {

            clearInterval(interval);

            return resolve(value);
          }

          if (
            Date.now() - start >=
            timeoutMs
          ) {

            clearInterval(interval);

            return resolve(null);
          }

        } catch {

          clearInterval(interval);

          return resolve(null);
        }

      }, intervalMs);
  });
}

// ============================================================
// SEND SESSION ID TO MESSAGE YOURSELF
// ============================================================

async function handlePostConnect(
  sock,
  account
) {

  try {

    if (!sock || !account) {

      console.error(
        '[Session] ❌ Socket or account missing.'
      );

      return false;
    }

    // --------------------------------------------------------
    // Don't generate it twice.
    // --------------------------------------------------------

    if (
      fs.existsSync(
        account.sessionSentFlag
      )
    ) {

      console.log(
        `[Session:${account.phone}] ℹ️ Session ID already delivered.`
      );

      return true;
    }

    console.log(
      `[Session:${account.phone}] ⏳ Waiting for credentials to finish saving...`
    );

    // Same delay as the old working index.js.
    await new Promise(resolve =>
      setTimeout(resolve, 3000)
    );

    // --------------------------------------------------------
    // CREATE SESSION ID
    // --------------------------------------------------------

    const sessionId =
      createSessionId(account);

    console.log('');
    console.log(
      `[Session:${account.phone}] ═════════════════════════════`
    );
    console.log(
      `[Session:${account.phone}] 🔑 SESSION ID GENERATED`
    );
    console.log(sessionId);
    console.log(
      `[Session:${account.phone}] ═════════════════════════════`
    );
    console.log('');

    // --------------------------------------------------------
    // GET SELF JID
    // --------------------------------------------------------

    const selfJid =
      sock.user?.id;

    if (!selfJid) {

      console.error(
        `[Session:${account.phone}] ❌ WhatsApp JID unavailable.`
      );

      return false;
    }

    // --------------------------------------------------------
    // MESSAGE 1 — SESSION ID
    // --------------------------------------------------------

    await sock.sendMessage(
      selfJid,
      {
        text: sessionId
      }
    );

    // Same delay as old working code.
    await new Promise(resolve =>
      setTimeout(resolve, 1200)
    );

    // --------------------------------------------------------
    // MESSAGE 2 — INFORMATION
    // --------------------------------------------------------

    const msg2 =
`╭━━〔 MUFASER-X SESSION 〕━━╮

✅ *WhatsApp Connected Successfully!*

🔐 *Your Session ID is ready.*

📦 *Copy the Session ID above.*

▬▬ι══════════════════ι▬▬
📱 *Number:* ${account.phone}
🤖 *Bot:* MUFASER-X
👨‍💻 *Developer:* ROMA-TECH
✅ *Status:* Connected
▬▬ι══════════════════ι▬▬
⚠️ *Keep this Session ID private.*

Deploy the bot on any panel you want.

▬▬ι══════════════════ι▬▬`;

    await sock.sendMessage(
      selfJid,
      {
        text: msg2
      }
    );

    // --------------------------------------------------------
    // MARK SESSION AS SENT
    // --------------------------------------------------------

    fs.mkdirSync(
      account.sessionDir,
      {
        recursive: true
      }
    );

    fs.writeFileSync(
      account.sessionSentFlag,
      new Date().toISOString(),
      'utf8'
    );

    console.log(
      `[Session:${account.phone}] ✅ Session ID sent to Message Yourself.`
    );

    console.log(
      `[Session:${account.phone}] 🏁 Session delivery completed.`
    );

    return true;

  } catch (error) {

    console.error(
      `[Session:${account?.phone || 'unknown'}] ❌ Failed to send Session ID:`,
      error.message
    );

    return false;
  }
}

// ============================================================
// CONNECT WHATSAPP
// THIS CONNECTION LOGIC IS BASED ON YOUR OLD WORKING FILE.
// ============================================================

async function connect(
  phoneNumber
) {

  const phone =
    normalizePhone(phoneNumber);

  if (!phone) {

    console.error(
      '[Bot] ❌ Phone number is required.'
    );

    return;
  }

  const account =
    getAccount(phone);

  if (!account) {

    console.error(
      `[Bot:${phone}] ❌ Failed to create account state.`
    );

    return;
  }

  // ----------------------------------------------------------
  // DUPLICATE CONNECTION PROTECTION
  // ----------------------------------------------------------

  if (account.isConnecting) {

    console.log(
      `[Bot:${phone}] ⚠️ Connection already in progress.`
    );

    return;
  }

  if (
    account.sock &&
    account.status === 'connected'
  ) {

    console.log(
      `[Bot:${phone}] ✅ Account already connected.`
    );

    return;
  }

  account.isConnecting = true;
  account.stopAfterSession = false;

  try {

    // --------------------------------------------------------
    // SESSION DIRECTORY
    // --------------------------------------------------------

    if (
      !fs.existsSync(
        account.sessionDir
      )
    ) {

      fs.mkdirSync(
        account.sessionDir,
        {
          recursive: true
        }
      );
    }

    // --------------------------------------------------------
    // BAILEYS AUTH STATE
    // --------------------------------------------------------

    const {
      state,
      saveCreds
    } =
      await useMultiFileAuthState(
        account.sessionDir
      );

    // --------------------------------------------------------
    // FETCH LATEST WHATSAPP VERSION
    // --------------------------------------------------------

    let version;

    try {

      const {
        version: latestVersion
      } =
        await fetchLatestBaileysVersion();

      version =
        latestVersion;

      console.log(
        `[Bot:${phone}] WhatsApp version: ${version.join('.')}`
      );

    } catch {

      console.log(
        `[Bot:${phone}] ⚠️ Using fallback WhatsApp version.`
      );

      version =
        [2, 3000, 1017546695];
    }

    console.log(
      `[Bot:${phone}] Registered: ${state.creds.registered}`
    );

    console.log(
      `[Bot:${phone}] 🔄 Starting WhatsApp connection...`
    );

    // --------------------------------------------------------
    // SOCKET
    //
    // IMPORTANT:
    // These options are copied from the working version.
    // --------------------------------------------------------

    const sock =
      makeWASocket({

        version,

        auth: {

          creds:
            state.creds,

          keys:
            makeCacheableSignalKeyStore(
              state.keys,
              logger
            )
        },

        browser: [
          'Ubuntu',
          'Chrome',
          '120.0.0.0'
        ],

        printQRInTerminal:
          false,

        syncFullHistory:
          false,

        markOnlineOnConnect:
          true,

        connectTimeoutMs:
          60000,

        defaultQueryTimeoutMs:
          30000,

        keepAliveIntervalMs:
          25000,

        maxRetries:
          5,

        fireInitQueries:
          false,

        emitOwnEvents:
          true,

        defaultCongestionControl:
          1,

        logger
      });

    account.sock =
      sock;

    account.status =
      state.creds.registered
        ? 'connecting'
        : 'generating_code';

    // --------------------------------------------------------
    // SAVE CREDENTIALS
    // --------------------------------------------------------

    sock.ev.on(
      'creds.update',
      async () => {

        try {

          await saveCreds();

          console.log(
            `[Session:${phone}] 💾 Credentials saved.`
          );

        } catch (error) {

          console.error(
            `[Session:${phone}] ❌ Failed to save credentials:`,
            error.message
          );
        }
      }
    );

    // --------------------------------------------------------
    // CONNECTION UPDATE
    // --------------------------------------------------------

    sock.ev.on(
      'connection.update',
      async update => {

        const {
          connection,
          lastDisconnect,
          qr
        } = update;

        const statusCode =
          lastDisconnect
            ?.error
            ?.output
            ?.statusCode;

        console.log(
          `[Bot:${phone}] connection.update →`,
          JSON.stringify({
            connection,
            hasQR: !!qr,
            statusCode
          })
        );

        // ----------------------------------------------------
        // QR
        // ----------------------------------------------------

        if (qr) {

          try {

            account.qrDataUrl =
              await QRCode.toDataURL(
                qr,
                {
                  width: 300
                }
              );

            account.pairingCode =
              null;

            account.status =
              'qr_ready';

            console.log(
              `[Bot:${phone}] 📷 QR code ready.`
            );

          } catch (error) {

            console.error(
              `[Bot:${phone}] ❌ QR generation failed:`,
              error.message
            );
          }
        }

        // ----------------------------------------------------
        // CONNECTING
        // ----------------------------------------------------

        if (
          connection ===
          'connecting'
        ) {

          console.log(
            `[Bot:${phone}] 🔄 Connecting to WhatsApp...`
          );

          if (
            account.status !==
              'waiting_approval' &&
            account.status !==
              'pairing_code_ready' &&
            account.status !==
              'qr_ready'
          ) {

            account.status =
              'connecting';
          }
        }

        // ----------------------------------------------------
        // CONNECTED
        // ----------------------------------------------------

        if (
          connection ===
          'open'
        ) {

          console.log('');
          console.log(
            `[Bot:${phone}] ═════════════════════════════`
          );
          console.log(
            `[Bot:${phone}] ✅ WHATSAPP CONNECTED!`
          );
          console.log(
            `[Bot:${phone}] ═════════════════════════════`
          );
          console.log('');

          account.status =
            'connected';

          account.isConnecting =
            false;

          account.pairingCode =
            null;

          account.qrDataUrl =
            null;

          // --------------------------------------------------
          // Give final auth files time to save.
          // Same timing as working version.
          // --------------------------------------------------

          await new Promise(
            resolve =>
              setTimeout(
                resolve,
                3000
              )
          );

          // --------------------------------------------------
          // GENERATE + SEND SESSION ID
          // --------------------------------------------------

          const sent =
            await handlePostConnect(
              sock,
              account
            );

          // --------------------------------------------------
          // IMPORTANT:
          // Private server must release the WhatsApp socket
          // after Session ID generation.
          //
          // This prevents the PUBLIC bot from competing for
          // the same WhatsApp authentication session.
          // --------------------------------------------------

          if (sent) {

            account.stopAfterSession =
              true;

            console.log(
              `[Bot:${phone}] 🔐 Session captured. Closing private pairing socket...`
            );

            try {

              if (
                sock &&
                typeof sock.end ===
                  'function'
              ) {

                sock.end(
                  undefined
                );
              }

            } catch (_) {}

            account.sock =
              null;

            account.isConnecting =
              false;

            account.status =
              'session_ready';

            console.log(
              `[Bot:${phone}] ✅ Private pairing completed.`
            );
          }
        }

        // ----------------------------------------------------
        // CLOSED
        // ----------------------------------------------------

        if (
          connection ===
          'close'
        ) {

          console.log(
            `[Bot:${phone}] ❌ WhatsApp connection closed.`
          );

          console.log(
            `[Bot:${phone}] Disconnect status: ${statusCode}`
          );

          account.sock =
            null;

          account.isConnecting =
            false;

          // --------------------------------------------------
          // If Session ID was successfully generated,
          // DO NOT reconnect the private server.
          // --------------------------------------------------

          if (
            account.stopAfterSession
          ) {

            console.log(
              `[Bot:${phone}] 🛑 Private pairing socket stopped intentionally.`
            );

            return;
          }

          const loggedOut =
            statusCode ===
            DisconnectReason.loggedOut;

          const badSession =
            statusCode ===
            DisconnectReason.badSession;

          // --------------------------------------------------
          // LOGGED OUT
          // --------------------------------------------------

          if (loggedOut) {

            console.log(
              `[Session:${phone}] 🚪 WhatsApp logged out.`
            );

            clearAccountSession(
              account
            );

            return;
          }

          // --------------------------------------------------
          // BAD SESSION
          // --------------------------------------------------

          if (badSession) {

            console.log(
              `[Session:${phone}] ⚠️ Bad session.`
            );

            clearAccountSession(
              account
            );

            return;
          }

          // --------------------------------------------------
          // TEMPORARY DISCONNECT
          // --------------------------------------------------

          account.status =
            'disconnected';

          if (
            config.autoReconnect
          ) {

            console.log(
              `[Bot:${phone}] 🔄 Reconnecting in 5 seconds...`
            );

            setTimeout(
              () => {

                const currentAccount =
                  accounts.get(phone);

                if (
                  !currentAccount
                ) {
                  return;
                }

                if (
                  currentAccount.status ===
                    'connected' ||
                  currentAccount.isConnecting
                ) {
                  return;
                }

                connect(phone)
                  .catch(error => {

                    console.error(
                      `[Bot:${phone}] ❌ Reconnect failed:`,
                      error.message
                    );
                  });

              },
              5000
            );
          }
        }
      }
    );

    // ========================================================
    // REQUEST PAIRING CODE
    //
    // THIS IS THE IMPORTANT PART FROM YOUR OLD WORKING FILE.
    // ========================================================

    if (
      !state.creds.registered
    ) {

      account.status =
        'generating_code';

      try {

        console.log(
          `[Bot:${phone}] 📱 Waiting for WhatsApp socket...`
        );

        // EXACT OLD WORKING DELAY
        await new Promise(
          resolve =>
            setTimeout(
              resolve,
              1500
            )
        );

        console.log(
          `[Bot:${phone}] 🔑 Requesting WhatsApp pairing code...`
        );

        const code =
          await sock.requestPairingCode(
            phone
          );

        if (!code) {

          throw new Error(
            'WhatsApp did not return a pairing code.'
          );
        }

        const formatted =
          String(code)
            .replace(
              /[^A-Za-z0-9]/g,
              ''
            )
            .match(
              /.{1,4}/g
            )
            ?.join('-') ||
          String(code);

        account.pairingCode =
          formatted;

        account.qrDataUrl =
          null;

        account.status =
          'waiting_approval';

        console.log('');
        console.log(
          `[Bot:${phone}] ═════════════════════════════`
        );
        console.log(
          `[Bot:${phone}] 🔑 PAIRING CODE: ${formatted}`
        );
        console.log(
          `[Bot:${phone}] 📱 WhatsApp → Linked Devices → Link with phone number`
        );
        console.log(
          `[Bot:${phone}] ═════════════════════════════`
        );
        console.log('');

      } catch (error) {

        console.error(
          `[Bot:${phone}] ❌ Failed to request pairing code:`,
          error.message
        );

        account.status =
          'failed';

        account.pairingCode =
          null;

        account.isConnecting =
          false;

        try {

          if (
            sock &&
            typeof sock.end ===
              'function'
          ) {

            sock.end(
              undefined
            );
          }

        } catch (_) {}

        account.sock =
          null;
      }
    }

  } catch (error) {

    console.error(
      `[Bot:${phone}] ❌ Fatal connection error:`,
      error.message
    );

    account.status =
      'failed';

    account.sock =
      null;

    account.isConnecting =
      false;
  }
}

// ============================================================
// EXPRESS SERVER
// ============================================================

const app =
  express();

app.use(
  express.json()
);

app.use(
  express.urlencoded({
    extended: true
  })
);

app.use(
  express.static(
    path.join(
      __dirname,
      'public'
    )
  )
);

// ============================================================
// HEALTH
// ============================================================

app.get(
  '/health',
  (req, res) => {

    res.send(
      'MUFASER-X Private Pairing Server Running Successfully'
    );
  }
);

// ============================================================
// PANEL
// ============================================================

app.get(
  '/',
  (req, res) => {

    res.sendFile(
      path.join(
        __dirname,
        'public',
        'index.html'
      )
    );
  }
);

app.get(
  '/pair',
  (req, res) => {

    res.sendFile(
      path.join(
        __dirname,
        'public',
        'index.html'
      )
    );
  }
);

// ============================================================
// ACCOUNT STATUS
// ============================================================

app.get(
  '/api/status',
  (req, res) => {

    const phone =
      normalizePhone(
        req.query.phone
      );

    if (!phone) {

      return res.json({

        status:
          'idle',

        connected:
          false,

        pairingCode:
          null,

        qrDataUrl:
          null,

        phone:
          null,

        message:
          'Enter your WhatsApp number to begin pairing.'
      });
    }

    const account =
      accounts.get(phone);

    if (!account) {

      return res.json({

        status:
          'session_not_found',

        connected:
          false,

        pairingCode:
          null,

        qrDataUrl:
          null,

        phone
      });
    }

    return res.json({

      status:
        account.status,

      connected:
        account.status ===
        'connected',

      pairingCode:
        account.pairingCode ||
        null,

      qrDataUrl:
        account.qrDataUrl ||
        null,

      phone
    });
  }
);

// ============================================================
// PAIRING CODE
// ============================================================

app.post(
  '/api/pair',
  async (req, res) => {

    console.log(
      '[API] 📥 /api/pair request:',
      req.body
    );

    const {
      phone
    } =
      req.body;

    if (!phone) {

      return res.status(400).json({

        success:
          false,

        error:
          'Phone number is required.'
      });
    }

    const clean =
      normalizePhone(phone);

    if (
      !clean ||
      clean.length < 7
    ) {

      return res.status(400).json({

        success:
          false,

        error:
          'Enter a valid international WhatsApp number.'
      });
    }

    const account =
      getAccount(clean);

    if (!account) {

      return res.status(500).json({

        success:
          false,

        error:
          'Failed to create account.'
      });
    }

    // --------------------------------------------------------
    // Already connected
    // --------------------------------------------------------

    if (
      account.status ===
      'connected'
    ) {

      return res.status(400).json({

        success:
          false,

        error:
          'This WhatsApp number is already connected.',

        phone:
          clean
      });
    }

    // --------------------------------------------------------
    // Already have pairing code
    // --------------------------------------------------------

    if (
      account.pairingCode &&
      (
        account.status ===
          'waiting_approval' ||
        account.status ===
          'pairing_code_ready'
      )
    ) {

      return res.json({

        success:
          true,

        phone:
          clean,

        pairingCode:
          account.pairingCode,

        status:
          'waiting_approval',

        message:
          'Enter this code in WhatsApp → Linked Devices → Link with phone number.'
      });
    }

    // --------------------------------------------------------
    // Connection already running
    // --------------------------------------------------------

    if (
      account.isConnecting
    ) {

      const existingCode =
        await waitFor(
          () =>
            accounts.get(clean)
              ?.pairingCode ||
            null,

          30000,

          250
        );

      if (!existingCode) {

        return res.status(408).json({

          success:
            false,

          error:
            'Timed out waiting for pairing code. Please try again.',

          phone:
            clean,

          status:
            accounts.get(clean)
              ?.status ||
            'failed'
        });
      }

      return res.json({

        success:
          true,

        phone:
          clean,

        pairingCode:
          existingCode,

        status:
          'waiting_approval',

        message:
          'Enter this code in WhatsApp → Linked Devices → Link with phone number.'
      });
    }

    // --------------------------------------------------------
    // RESET TEMPORARY STATE
    // --------------------------------------------------------

    account.pairingCode =
      null;

    account.qrDataUrl =
      null;

    account.status =
      'generating_code';

    account.stopAfterSession =
      false;

    console.log(
      `[API:${clean}] 📱 Starting WhatsApp pairing...`
    );

    // --------------------------------------------------------
    // START CONNECTION
    // --------------------------------------------------------

    connect(clean)
      .catch(error => {

        console.error(
          `[API:${clean}] ❌ Pairing connection error:`,
          error.message
        );

        const current =
          accounts.get(clean);

        if (current) {

          current.status =
            'failed';

          current.isConnecting =
            false;
        }
      });

    // --------------------------------------------------------
    // WAIT FOR PAIRING CODE
    // --------------------------------------------------------

    const code =
      await waitFor(
        () =>
          accounts.get(clean)
            ?.pairingCode ||
          null,

        30000,

        250
      );

    if (!code) {

      const current =
        accounts.get(clean);

      return res.status(408).json({

        success:
          false,

        error:
          'Timed out generating pairing code. Please try again.',

        phone:
          clean,

        status:
          current?.status ||
          'failed'
      });
    }

    console.log(
      `[API:${clean}] ✅ Pairing code ready: ${code}`
    );

    return res.json({

      success:
        true,

      phone:
        clean,

      pairingCode:
        code,

      status:
        'waiting_approval',

      message:
        'Open WhatsApp → Linked Devices → Link with phone number, then enter this code.'
    });
  }
);

// ============================================================
// START QR
// ============================================================

app.post(
  '/api/start-qr',
  async (req, res) => {

    console.log(
      '[API] 📥 /api/start-qr request:',
      req.body
    );

    const {
      phone
    } =
      req.body;

    if (!phone) {

      return res.status(400).json({

        success:
          false,

        error:
          'Phone number is required for QR pairing.'
      });
    }

    const clean =
      normalizePhone(phone);

    if (
      !clean ||
      clean.length < 7
    ) {

      return res.status(400).json({

        success:
          false,

        error:
          'Enter a valid international phone number.'
      });
    }

    const account =
      getAccount(clean);

    if (!account) {

      return res.status(500).json({

        success:
          false,

        error:
          'Failed to create account.'
      });
    }

    if (
      account.status ===
      'connected'
    ) {

      return res.status(400).json({

        success:
          false,

        error:
          'This WhatsApp number is already connected.',

        phone:
          clean
      });
    }

    // --------------------------------------------------------
    // Existing connection
    // --------------------------------------------------------

    if (
      account.isConnecting &&
      (
        account.status ===
          'connecting' ||
        account.status ===
          'qr_ready'
      )
    ) {

      const existingQr =
        await waitFor(
          () =>
            accounts.get(clean)
              ?.qrDataUrl ||
            null,

          15000,

          300
        );

      if (!existingQr) {

        return res.status(408).json({

          success:
            false,

          error:
            'Timed out waiting for QR code. Please try again.',

          phone:
            clean,

          status:
            account.status
        });
      }

      return res.json({

        success:
          true,

        phone:
          clean,

        qrDataUrl:
          existingQr,

        status:
          'qr_ready'
      });
    }

    account.pairingCode =
      null;

    account.qrDataUrl =
      null;

    account.status =
      'connecting';

    account.stopAfterSession =
      false;

    connect(clean)
      .catch(error => {

        console.error(
          `[API:${clean}] ❌ QR connection error:`,
          error.message
        );

        const current =
          accounts.get(clean);

        if (current) {

          current.status =
            'failed';

          current.isConnecting =
            false;
        }
      });

    const qr =
      await waitFor(
        () =>
          accounts.get(clean)
            ?.qrDataUrl ||
          null,

        15000,

        300
      );

    if (!qr) {

      const current =
        accounts.get(clean);

      return res.status(408).json({

        success:
          false,

        error:
          'Timed out waiting for QR code. Please try again.',

        phone:
          clean,

        status:
          current?.status ||
          'failed'
      });
    }

    return res.json({

      success:
        true,

      phone:
        clean,

      qrDataUrl:
        qr,

      status:
        'qr_ready'
    });
  }
);

// ============================================================
// GET QR
// ============================================================

app.get(
  '/api/qr',
  (req, res) => {

    const phone =
      normalizePhone(
        req.query.phone
      );

    if (!phone) {

      return res.status(400).json({

        success:
          false,

        error:
          'Phone number is required.'
      });
    }

    const account =
      accounts.get(phone);

    if (!account) {

      return res.status(404).json({

        success:
          false,

        error:
          'Account not found.',

        phone
      });
    }

    if (!account.qrDataUrl) {

      return res.status(404).json({

        success:
          false,

        error:
          'No QR code available for this number.',

        phone,

        status:
          account.status
      });
    }

    return res.json({

      success:
        true,

      phone,

      qrDataUrl:
        account.qrDataUrl,

      status:
        account.status
    });
  }
);
// ============================================================
// PUBLIC → PRIVATE COMMAND BRIDGE
// ============================================================

app.post(
  '/api/command',
  async (req, res) => {

    try {

      // --------------------------------------------------------
      // API KEY
      // --------------------------------------------------------

      const incomingKey =
        String(
          req.headers['x-api-key'] || ''
        ).trim();

      if (
        incomingKey !==
        String(config.apiKey || '').trim()
      ) {

        return res.status(401).json({
          success: false,
          error: 'Unauthorized'
        });

      }

      // --------------------------------------------------------
      // COMMAND DATA
      // --------------------------------------------------------

      const command =
        String(
          req.body?.command || ''
        )
          .trim()
          .toLowerCase();

      const args =
        Array.isArray(req.body?.args)
          ? req.body.args
          : [];

      const jid =
        String(
          req.body?.jid || ''
        );

      const sender =
        String(
          req.body?.sender || ''
        );

      const text =
        String(
          req.body?.text || ''
        );

      const accountId =
        String(
          req.body?.accountId || ''
        );

      console.log(
        `[BRIDGE] 📥 Received command: .${command}`
      );

      console.log(
        `[BRIDGE] 👤 Sender: ${sender || 'unknown'}`
      );

      console.log(
        `[BRIDGE] 📱 Account: ${accountId || 'unknown'}`
      );

      // --------------------------------------------------------
      // EMPTY COMMAND
      // --------------------------------------------------------

      if (!command) {

        return res.json({
          success: false,
          message: 'No command received.'
        });

      }

      // --------------------------------------------------------
      // FIND COMMAND
      // --------------------------------------------------------

      const commandHandler =
        commands.get(command);

      if (!commandHandler) {

        return res.json({

          success: false,

          message:
            `Command .${command} was not found on the private server.`

        });

      }

      console.log(
        `[BRIDGE] ✅ Loaded command: .${command}`
      );

      // ========================================================
      // ACTION QUEUE
      // ========================================================

      const actions = [];

      // ========================================================
      // BRIDGE SOCKET
      // ========================================================

      const bridgeSock = {

        async sendMessage(
          targetJid,
          content
        ) {

          const action = {

            type:
              'sendMessage',

            jid:
              targetJid,

            content

          };

          actions.push(
            action
          );

          return action;

        },

        async sendPresenceUpdate(
          presence,
          targetJid
        ) {

          const action = {

            type:
              'presence',

            jid:
              targetJid,

            presence

          };

          actions.push(
            action
          );

          return action;

        }

      };

      // ========================================================
      // MESSAGE OBJECT
      // ========================================================

      const msg = {

        key: {

          remoteJid:
            jid,

          fromMe:
            false,

          participant:
            sender || undefined

        },

        message: {

          conversation:
            text

        },

        pushName:
          sender || 'User'

      };

      // ========================================================
      // SENDER OBJECT
      // ========================================================

      const senderInfo = {

        number:
          sender,

        name:
          sender || 'User'

      };

      // ========================================================
      // ACCOUNT OBJECT
      // ========================================================

      const account = {

        id:
          accountId,

        phone:
          accountId,

        sock:
          bridgeSock

      };

      // ========================================================
      // EXECUTE COMMAND
      // ========================================================

      console.log(
        `[BRIDGE] ⚙️ Executing: .${command}`
      );

      const result =
        await commandHandler.execute(
          bridgeSock,
          msg,
          jid,
          args,
          senderInfo,
          account
        );

      console.log(
        `[BRIDGE] ✅ Executed: .${command}`
      );

      console.log(
        `[BRIDGE] 📤 WhatsApp actions queued: ${actions.length}`
      );

      // ========================================================
      // RETURN RESULT + ACTIONS TO PUBLIC SERVER
      // ========================================================

      return res.json({

        success:
          true,

        command,

        result:
          result === undefined
            ? null
            : result,

        actions

      });

    } catch (error) {

      console.error(
        '[BRIDGE] ❌ Command execution error:',
        error
      );

      return res.status(500).json({

        success:
          false,

        error:
          error.message ||
          'Private command execution failed.'

      });

    }

  }
);
// ============================================================
// START SERVER
// ============================================================

async function start() {

  console.log(`
╔════════════════════════════════════╗
║     MUFASER-X PRIVATE SERVER       ║
║          Developer: ROMA-TECH      ║
║       Pairing + Session Only       ║
╚════════════════════════════════════╝
`);

  const sessionsDir =
    path.join(
      __dirname,
      'sessions'
    );

  if (
    !fs.existsSync(
      sessionsDir
    )
  ) {

    fs.mkdirSync(
      sessionsDir,
      {
        recursive: true
      }
    );
  }

  app.listen(
    config.port,
    () => {

      console.log(
        `[Server] 🌐 Running on port ${config.port}`
      );

      console.log(
        `[Server] 📲 Pairing panel ready`
      );

      console.log(
        `[Server] 🔐 Private Session Server active`
      );
    }
  );
}

// ============================================================
// PROCESS ERROR HANDLERS
// ============================================================

process.on(
  'uncaughtException',
  error => {

    console.error(
      '[Bot] Uncaught exception:',
      error
    );
  }
);

process.on(
  'unhandledRejection',
  reason => {

    console.error(
      '[Bot] Unhandled rejection:',
      reason
    );
  }
);

// ============================================================
// START
// ============================================================

start();

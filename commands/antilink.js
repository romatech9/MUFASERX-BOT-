module.exports = {
    name: "antilink",
    execute: async (sock, msg, args) => {
        const chat = msg.key.remoteJid;

        if (!chat.endsWith("@g.us")) {
            return sock.sendMessage(chat, { text: "❌ This only works in groups." });
        }

        global.antilink = global.antilink || {};

        const action = args[0]?.toLowerCase();

        if (action === "on") {
            global.antilink[chat] = true;
            return sock.sendMessage(chat, { text: "🛡️ Anti-link ENABLED" });
        }

        if (action === "off") {
            global.antilink[chat] = false;
            return sock.sendMessage(chat, { text: "❌ Anti-link DISABLED" });
        }

        return sock.sendMessage(chat, {
            text: "Usage: .antilink on / off"
        });
    }
};
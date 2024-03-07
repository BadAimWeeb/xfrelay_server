import "dotenv/config";
import fs from "fs/promises";
import { existsSync } from "fs";
import path from "path";

import { Server as Pv2dServer, keyGeneration } from "@badaimweeb/js-protov2d";
import { DTSocketServer, InitProcedureGenerator, type ServerContext, type Socket } from "@badaimweeb/js-dtsocket";
import z from "zod";

type SpecificData = "currentUserID" | "serverAppID" | "lsVersion";
let specificDataGuard = z.union([
    z.literal("currentUserID"),
    z.literal("serverAppID"),
    z.literal("lsVersion")
]);
type SpecificDataResponse = string;

// very hacky
type CSocket = Parameters<Parameters<DTSocketServer["cSockets"]["forEach"]>[0]>[0];
type GlobalData = {
    [accountID: string]: [tabID: string, expires: number, socket: CSocket][]
};

type LocalData = {
    account?: string,
    outputAccount?: string
}

const gState: GlobalData = {};

type InitialContext = ServerContext<GlobalData, LocalData, {
    csEvents: {
        data: (tabID: string, data: string) => void; // send fb data to relay
        specificData: (nonce: number, specificData: SpecificDataResponse) => void; // browser response to requestSpecificData
        httpInjResponseData: (data: string, nonce: string) => void; // response from browser to fca
        uploadAttachmentResponse: (data: string, nonce: string) => void; // response from browser to fca
    },
    scEvents: {
        recData: (tabID: string, data: string) => void; // data sent from browser to relay server
        injData: (qos: number, data: string, tabID?: string | undefined) => void; // data sent from fca to relay server
        httpInjData: (data: string, nonce: string, tabID: string | undefined) => void; // data sent from fca to relay server
        uploadAttachmentData: (dataEncrypted: string, nonce: string, tabID: string | undefined) => void; // data sent from fca to relay server
        newTab: (tabID: string[]) => void; // new tab created
        delTab: (tabID: string[]) => void; // tab closed
        requestSpecificData: (tabID: string, specificData: SpecificData, nonce: number) => void; // request specific data from browser
    }
}, Socket>;

const p = InitProcedureGenerator<InitialContext>();
const procedures = {
    // Browser-side
    registerInput: p
        .input(z.string())
        .resolve(async (_gState, lState, input, socket) => {
            lState.account = input;
            socket.rooms.clear();
            socket.join("INPUT!" + input);
            return true;
        }),

    registerInputTab: p
        .input(
            z.string()
                .or(z.array(z.string()))
        )
        .resolve(async (gState: GlobalData, lState, input, socket) => {
            if (lState.account === void 0) return false;
            if (!Array.isArray(input)) input = [input];

            for (const tabID of input) {
                if (gState[lState.account] === void 0) gState[lState.account] = [];
                
                let index = gState[lState.account].findIndex((v) => v[0] === tabID)
                if (index + 1) {
                    gState[lState.account][index][1] = Date.now() + 1000 * 60; // 60s to live
                } else {
                    gState[lState.account].push([tabID, Date.now() + 1000 * 60, socket]);
                    apiServer.to(lState.account).emit("newTab", [tabID]);
                }
            }

            return true;
        }),

    unregisterInputTab: p
        .input(
            z.string()
                .or(z.array(z.string()))
        )
        .resolve(async (gState: GlobalData, lState, input) => {
            if (lState.account === void 0) return false;
            if (!Array.isArray(input)) input = [input];

            let deletedTabs: string[] = [];
            for (const tabID of input) {
                if (gState[lState.account] === void 0) gState[lState.account] = [];
                let index = gState[lState.account].findIndex((v) => v[0] === tabID)
                if (index + 1) {
                    deletedTabs.push(tabID);
                    gState[lState.account].splice(index, 1);
                }
            }

            if (deletedTabs.length > 0) {
                apiServer.to(lState.account).emit("delTab", deletedTabs);
            }

            return true;
        }),

    getFCAClients: p
        .input(z.void())
        .resolve(async (gState, lState, _, socket) => {
            if (lState.account === void 0) return [];
            if (gState[lState.account] === void 0) return [];

            return socket.server.rooms.get(lState.account)?.size || 0;
        }),

    // Both side
    getTabs: p
        .input(z.void())
        .resolve(async (gState: GlobalData, lState) => {
            if (lState.outputAccount === void 0 && lState.account === void 0) return [];
            if (gState[lState.outputAccount || lState.account] === void 0) return [];

            return gState[lState.outputAccount || lState.account]
                .filter((v) => v[1] > Date.now())
                .map((v) => v[0]);
        }),

    // FCA-side
    registerOutput: p
        .input(z.string())
        .resolve(async (_gState, lState, input, socket) => {
            socket.rooms.clear();
            socket.join(input);

            lState.outputAccount = input;
        }),

    injectData: p
        .input(z.object({
            data: z.string(),
            qos: z.number(),
            tabID: z.string().optional()
        }))
        .resolve(async (gState: GlobalData, lState, input, socket): Promise<boolean> => {
            if (lState.outputAccount === void 0) return false;
            if (gState[lState.outputAccount] === void 0) return false;
            gState[lState.outputAccount] = gState[lState.outputAccount]
                .filter((v) => v[1] > Date.now() ? true : (socket.to(v[0]).emit("delTab", [v[0]]), false));

            if (input.tabID === void 0) {
                // Select random tab
                const tabs = gState[lState.outputAccount];
                if (tabs.length === 0) return false;

                const tab = tabs[Math.floor(Math.random() * tabs.length)];
                return tab[2].emit("injData", input.qos, input.data, tab[0]);
            } else {
                let tab = gState[lState.outputAccount].find((v) => v[0] === input.tabID);
                if (!tab) return false;
                return tab[2].emit("injData", input.qos, input.data, input.tabID);
            }
        }),

    requestSpecificData: p
        .input(z.object({
            tabID: z.string(),
            specificData: specificDataGuard
        }))
        .resolve(async (gState: GlobalData, lState, input): Promise<SpecificDataResponse> => {
            if (lState.outputAccount === void 0) return "";
            if (gState[lState.outputAccount] === void 0) return "";

            if (gState[lState.outputAccount].findIndex((v) => v[0] === input.tabID) === -1) return "";

            let nonce = crypto.getRandomValues(new Uint32Array(1))[0];
            return new Promise((resolve) => {
                const listener = (returnNonce: number, specificData: SpecificDataResponse) => {
                    if (nonce !== returnNonce) return;

                    apiServer.off("specificData", listener);
                    resolve(specificData);
                };
                apiServer.on("specificData", listener);
                apiServer.to("INPUT!" + lState.outputAccount).emit("requestSpecificData", input.tabID, input.specificData, nonce);
            });
        }),

    sendHTTPRequest: p
        .input(z.object({
            data: z.string(),
            tabID: z.string().optional().nullable()
        }))
        .resolve(async (_gState, lState, input, socket) => {
            if (lState.outputAccount === void 0) return false;
            if (gState[lState.outputAccount] === void 0) return false;
            gState[lState.outputAccount] = gState[lState.outputAccount]
                .filter((v) => v[1] > Date.now() ? true : (socket.to(v[0]).emit("delTab", [v[0]]), false));

            let tab: (typeof gState)[string][number];
            if (input.tabID === void 0) {
                // Select random tab
                const tabs = gState[lState.outputAccount];
                if (tabs.length === 0) return false;

                tab = tabs[Math.floor(Math.random() * tabs.length)];
            } else {
                tab = gState[lState.outputAccount].find((v) => v[0] === input.tabID)!;
                if (!tab) return false;
            }

            let nonce = [...crypto.getRandomValues(new Uint32Array(4))].map(x => x.toString(16).padStart(8, "0")).join("");
            return new Promise((resolve) => {
                const listener = (data: string, returnNonce: string) => {
                    if (nonce !== returnNonce) return;

                    tab[2].off("httpInjResponseData", listener);
                    resolve(data);
                };

                tab[2].on("httpInjResponseData", listener);
                tab[2].emit("httpInjData", input.data, nonce, tab[0]);
            });
        }),

    uploadAttachment: p
        .input(z.object({
            dataEncrypted: z.string(),
            tabID: z.string().optional().nullable()
        }))
        .resolve(async (_gState, lState, input, socket) => {
            if (lState.outputAccount === void 0) return false;
            if (gState[lState.outputAccount] === void 0) return false;
            gState[lState.outputAccount] = gState[lState.outputAccount]
                .filter((v) => v[1] > Date.now() ? true : (socket.to(v[0]).emit("delTab", [v[0]]), false));

            let tab: (typeof gState)[string][number];
            if (input.tabID === void 0) {
                // Select random tab
                const tabs = gState[lState.outputAccount];
                if (tabs.length === 0) return false;

                tab = tabs[Math.floor(Math.random() * tabs.length)];
            } else {
                tab = gState[lState.outputAccount].find((v) => v[0] === input.tabID)!;
                if (!tab) return false;
            }

            let nonce = [...crypto.getRandomValues(new Uint32Array(4))].map(x => x.toString(16).padStart(8, "0")).join("");
            return new Promise<string>((resolve) => {
                const listener = (data: string, returnNonce: string) => {
                    if (nonce !== returnNonce) return;

                    tab[2].off("uploadAttachmentResponse", listener);
                    resolve(data);
                };

                tab[2].on("uploadAttachmentResponse", listener);
                tab[2].emit("uploadAttachmentData", input.dataEncrypted, nonce, tab[0]);
            });
        })
};

const apiServer = new DTSocketServer<
    ServerContext<
        GlobalData,
        LocalData,
        {
            csEvents: {
                data: (tabID: string, data: string) => void; // send fb data to relay
                specificData: (nonce: number, specificData: SpecificDataResponse) => void; // browser response to requestSpecificData
                httpInjResponseData: (data: string, nonce: string) => void; // response from browser to fca
                uploadAttachmentResponse: (data: string, nonce: string) => void; // response from browser to fca
            },
            scEvents: {
                recData: (tabID: string, data: string) => void; // data sent from browser to relay server
                injData: (qos: number, data: string, tabID?: string | undefined) => void; // data sent from fca to relay server
                httpInjData: (data: string, nonce: string, tabID: string | undefined) => void; // data sent from fca to relay server
                uploadAttachmentData: (dataEncrypted: string, nonce: string, tabID: string | undefined) => void; // data sent from fca to relay server
                newTab: (tabID: string[]) => void; // new tab created
                delTab: (tabID: string[]) => void; // tab closed
                requestSpecificData: (tabID: string, specificData: SpecificData, nonce: number) => void; // request specific data from browser
            }
        },
        Socket,
        typeof procedures
    >
>(procedures, gState);

let key: {
    privateKey: string;
    publicKey: string;
    publicKeyHash: string;
};

if (existsSync(path.join(process.cwd(), "pqkey.json"))) {
    key = JSON.parse(await fs.readFile(path.join(process.cwd(), "pqkey.json"), "utf-8"));
} else {
    key = await keyGeneration();
    await fs.writeFile(path.join(process.cwd(), "pqkey.json"), JSON.stringify(key));
}

const server = new Pv2dServer({
    port: +(process.env.PORT || 3000),
    privateKey: key.privateKey,
    publicKey: key.publicKey
});

server.on("connection", (socket) => {
    apiServer.processSession(socket);
});

apiServer.on("session", (cSocket) => {
    cSocket.on("data", (tabID: string, data: string) => {
        if (cSocket.lState.account === void 0) return;
        apiServer.to(cSocket.lState.account).emit("recData", tabID, data);
    });
});

console.log("PQ hash:", key.publicKeyHash);
console.log("(append !<hash> to the end of URL to be able to connect to this server)");

export type API = typeof apiServer;

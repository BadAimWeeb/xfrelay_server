import "dotenv/config";
import fs from "fs/promises";
import { existsSync } from "fs";
import path from "path";

import { Server as Pv2dServer, keyGeneration } from "@badaimweeb/js-protov2d";
import { DTSocketServer, InitProcedureGenerator, type Socket } from "@badaimweeb/js-dtsocket";
import z from "zod";

type SpecificData = never;
type SpecificDataResponse = never;

type GlobalData = {
    [accountID: string]: [tabID: string, expires: number][]
};

type LocalData = {
    account?: string,
    outputAccount?: string
}

const gState: GlobalData = {};

const p = InitProcedureGenerator<GlobalData, LocalData>();
const procedures = {
    // Browser-side
    registerInput: p
        .input(z.string())
        .resolve(async (_gState, lState, input) => {
            lState.account = input;
            return true;
        }),
    registerInputTab: p
        .input(
            z.string()
                .or(z.array(z.string()))
        )
        .resolve(async (_gState, lState, input, socket) => {
            if (lState.account === void 0) return false;
            if (!Array.isArray(input)) input = [input];

            for (const tabID of input) {
                if (_gState[lState.account] === void 0) _gState[lState.account] = [];
                let index = _gState[lState.account].findIndex((v) => v[0] === tabID)
                if (index + 1) {
                    _gState[lState.account][index][1] = Date.now() + 1000 * 60; // 60s to live
                }
            }

            return true;
        }),
    unregisterInputTab: p
        .input(
            z.string()
                .or(z.array(z.string()))
        )
        .resolve(async (_gState, lState, input, socket) => {
            if (lState.account === void 0) return false;
            if (!Array.isArray(input)) input = [input];

            for (const tabID of input) {
                if (_gState[lState.account] === void 0) _gState[lState.account] = [];
                let index = _gState[lState.account].findIndex((v) => v[0] === tabID)
                if (index + 1) {
                    _gState[lState.account].splice(index, 1);
                }
            }

            return true;
        }),

    // FCA-side
    registerOutput: p
        .input(z.string())
        .resolve(async (_gState, lState, input, socket) => {
            socket.rooms.clear();
            socket.join(input);

            lState.outputAccount = input;
        }),
    getTabs: p
        .input(z.void())
        .resolve(async (_gState, lState) => {
            if (lState.outputAccount === void 0) return [];
            if (_gState[lState.outputAccount] === void 0) return [];

            return _gState[lState.outputAccount]
                .filter((v) => v[1] > Date.now())
                .map((v) => v[0]);
        }),
    injectData: p
        .input(z.object({
            data: z.string(),
            tabID: z.string().optional()
        }))
        .resolve(async (_gState, lState, input, socket) => {
            if (lState.outputAccount === void 0) return false;
            if (_gState[lState.outputAccount] === void 0) return false;
            _gState[lState.outputAccount] = _gState[lState.outputAccount]
                .filter((v) => v[1] > Date.now() ? true : (socket.to(v[0]).emit("delTab", [v[0]]), false));

            if (input.tabID === void 0) {
                // Select random tab
                const tabs = _gState[lState.outputAccount];
                if (tabs.length === 0) return false;

                const tab = tabs[Math.floor(Math.random() * tabs.length)];
                apiServer.to(lState.outputAccount).emit("injData", input.data, tab[0]);
            } else {
                if (_gState[lState.outputAccount].findIndex((v) => v[0] === input.tabID) === -1) return false;
                apiServer.to(lState.outputAccount).emit("injData", input.data, input.tabID);
            }

            return true;
        })
};

const apiServer = new DTSocketServer<
    GlobalData,
    LocalData,
    {
        csEvents: {
            data: (tabID: string, data: string) => void; // send fb data to relay
            specificData: (nonce: number, specificData: SpecificDataResponse) => void; // browser response to requestSpecificData
        },
        scEvents: {
            recData: (tabID: string, data: string) => void; // data sent from browser to relay server
            injData: (data: string, tabID?: string | undefined) => void; // data sent from fca to relay server
            newTab: (tabID: string[]) => void; // new tab created
            delTab: (tabID: string[]) => void; // tab closed
            requestSpecificData: (tabID: string, specificData: SpecificData, nonce: number) => void; // request specific data from browser
        }
    },
    typeof procedures
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

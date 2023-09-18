import "dotenv/config";
import fs from "fs/promises";
import { existsSync } from "fs";
import path from "path";

import { Server as Pv2dServer, keyGeneration } from "@badaimweeb/js-protov2d";
import { DTSocketServer, InitProcedureGenerator } from "@badaimweeb/js-dtsocket";
import z from "zod";

const p = InitProcedureGenerator<
    {}, {
        account?: string
    }
>();

const apiServer = new DTSocketServer<
    {}, {
        account?: string
    }, {
        csEvents: {
            data: (tabID: string, data: string) => void; // send fb data to relay
        },
        scEvents: {
            recData: (tabID: string, data: string) => void; // data sent from browser to relay server
            injData: (data: string, tabID?: string | undefined) => void; // data sent from fca to relay server
        }
    }
>({
    registerInput: p
        .input(z.string())
        .resolve(async (_gState, lState, input) => {
            lState.account = input;
            return true;
        }),
    registerOutput: p
        .input(z.string())
        .resolve(async (_gState, lState, input, socket) => {
            socket.rooms.clear();
            socket.join(input);
        }),
    injectData: p
        .input(z.object({
            data: z.string(),
            tabID: z.string().optional()
        }))
        .resolve(async (_gState, lState, input, socket) => {
            // todo
        })
});

let key: {
    privateKey: string;
    publicKey: string;
    publicKeyHash: string;
} | undefined = void 0;

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

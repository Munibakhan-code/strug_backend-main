import { CommunicationIdentityClient } from "@azure/communication-identity";
import { RoomsClient } from "@azure/communication-rooms";
import dotenv from "dotenv";

dotenv.config();

const connectionString = process.env.AZURE_COMMUNICATION_CONNECTION_STRING;
const identityClient = connectionString ? new CommunicationIdentityClient(connectionString) : null;
const roomsClient = connectionString ? new RoomsClient(connectionString) : null;

export const createACSRoom = async () => {
    if (!roomsClient) throw new Error("ACS_NOT_CONFIGURED");
    try {
        const validFrom = new Date();
        const validUntil = new Date(validFrom.getTime() + 24 * 60 * 60 * 1000);
        const roomModel = await roomsClient.createRoom({ validFrom, validUntil });
        return roomModel.id;
    } catch (err) {
        throw new Error("ACS_ROOM_CREATION_FAILED");
    }
};

export const generateUserToken = async (scope = ["voip"]) => {
    if (!identityClient) throw new Error("ACS_NOT_CONFIGURED");
    try {
        const user = await identityClient.createUser();
        const tokenResponse = await identityClient.getToken(user, scope);
        return {
            user_id: user.communicationUserId,
            token: tokenResponse.token,
            expires_at: tokenResponse.expiresOn
        };
    } catch (err) {
        throw new Error("ACS_TOKEN_GENERATION_FAILED");
    }
};
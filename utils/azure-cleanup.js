// utils/azure-cleanup.js
import { BlobServiceClient } from '@azure/storage-blob';
import dotenv from 'dotenv';
dotenv.config();

const azureConnectionString = process.env.AZURE_STORAGE_CONNECTION_STRING?.trim();
const blobServiceClient = azureConnectionString
    ? BlobServiceClient.fromConnectionString(azureConnectionString)
    : null;
if (!blobServiceClient) {
    console.warn('[azure-cleanup] AZURE_STORAGE_CONNECTION_STRING is not set; blob deletion is disabled.');
}

export const deleteAzureBlob = async (containerName, blobUrl) => {
    try {
        if (!blobServiceClient) return;
        if (!blobUrl || blobUrl.includes('pending')) return;
        
       
        const urlParts = blobUrl.split('/');
        const blobName = urlParts.slice(4).join('/'); 
        
        const containerClient = blobServiceClient.getContainerClient(containerName);
        const blockBlobClient = containerClient.getBlockBlobClient(blobName);
        
        await blockBlobClient.deleteIfExists();
        console.log(`🗑️ [Cloud Cleanup] Deleted: ${blobName}`);
    } catch (err) {
        console.error("❌ [Cloud Cleanup] Error deleting blob:", err.message);
    }
};

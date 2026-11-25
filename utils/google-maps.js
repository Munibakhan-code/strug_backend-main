// utils/google-maps.js
import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

const API_KEY = process.env.GOOGLE_MAPS_API_KEY;
const configuredGoogleMapsTimeoutMs = Number.parseInt(process.env.GOOGLE_MAPS_TIMEOUT_MS || '2500', 10);
const GOOGLE_MAPS_TIMEOUT_MS = Number.isFinite(configuredGoogleMapsTimeoutMs) && configuredGoogleMapsTimeoutMs > 0
    ? configuredGoogleMapsTimeoutMs
    : 2500;

export const getDistanceMatrix = async (origins, destinations) => {
    if (!API_KEY) return null;
    try {
        const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(origins)}&destinations=${encodeURIComponent(destinations)}&key=${API_KEY}`;
        const response = await axios.get(url, { timeout: GOOGLE_MAPS_TIMEOUT_MS });
        const element = response.data.rows?.[0]?.elements?.[0];
        if (!element || element.status !== 'OK') return null;
        return element;
    } catch {
        return null;
    }
};


export const geocodeAddress = async (address) => {
    if (!API_KEY) return null;
    try {
        const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${API_KEY}`;
        const response = await axios.get(url, { timeout: GOOGLE_MAPS_TIMEOUT_MS });
        const result = response.data.results?.[0];
        if (!result) return null;
        const { lat, lng } = result.geometry.location;
        return { lat, lng };
    } catch {
        return null;
    }
};

export const getCountryFromCoords = async (latlng) => {
    if (!API_KEY) return "default";
    try {
        const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${latlng}&key=${API_KEY}`;
        const response = await axios.get(url, { timeout: GOOGLE_MAPS_TIMEOUT_MS });
        
        // Google response 
        const addressComponents = response.data.results[0].address_components;
        const country = addressComponents.find(c => c.types.includes('country')).long_name;
        
        return country; 
    } catch (err) {
        return "default"; 
    }
};

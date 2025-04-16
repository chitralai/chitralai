import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { RekognitionClient } from '@aws-sdk/client-rekognition';

const region = import.meta.env.VITE_AWS_REGION;
const accessKeyId = import.meta.env.VITE_AWS_ACCESS_KEY_ID;
const secretAccessKey = import.meta.env.VITE_AWS_SECRET_ACCESS_KEY;

// Development mode check
export const isDevelopment = import.meta.env.DEV || false;

// Validate required environment variables
const validateEnvVariables = () => {
    const requiredVars = {
        'AWS Access Key ID': import.meta.env.VITE_AWS_ACCESS_KEY_ID,
        'AWS Secret Access Key': import.meta.env.VITE_AWS_SECRET_ACCESS_KEY,
        'S3 Bucket Name': import.meta.env.VITE_S3_BUCKET_NAME
    };

    const missingVars = Object.entries(requiredVars)
        .filter(([_, value]) => !value)
        .map(([name]) => name);

    if (missingVars.length > 0) {
        throw new Error(`Missing required environment variables: ${missingVars.join(', ')}`);
    }

    return {
        accessKeyId: import.meta.env.VITE_AWS_ACCESS_KEY_ID,
        secretAccessKey: import.meta.env.VITE_AWS_SECRET_ACCESS_KEY,
        bucketName: import.meta.env.VITE_S3_BUCKET_NAME
    };
};

// Get validated credentials
const { accessKeyId: validatedAccessKeyId, secretAccessKey: validatedSecretAccessKey, bucketName } = validateEnvVariables();

// Initialize S3 client with proper configuration for direct upload
export const s3Client = new S3Client({
    region,
    credentials: {
        accessKeyId: validatedAccessKeyId,
        secretAccessKey: validatedSecretAccessKey
    },
    forcePathStyle: false // Use virtual hosted-style URLs for S3
});

// Initialize Rekognition client
export const rekognitionClient = new RekognitionClient({
    region,
    credentials: {
        accessKeyId: validatedAccessKeyId,
        secretAccessKey: validatedSecretAccessKey
    }
});

// S3 bucket configuration
export const S3_BUCKET_NAME = bucketName;

// Helper function to ensure folder structure exists
export const ensureFolderStructure = async (userId: string) => {
    try {
        // Create the folder structure by creating a zero-byte object
        const folderKey = `users/${userId}/logo/`;
        const command = new PutObjectCommand({
            Bucket: S3_BUCKET_NAME,
            Key: folderKey,
            Body: '',
            ContentLength: 0
        });

        await s3Client.send(command);
        console.log('Created folder structure:', folderKey);
        return true;
    } catch (error) {
        console.error('Error creating folder structure:', error);
        return false;
    }
};

// Helper function to generate organization logo path
export const getOrganizationLogoPath = (userId: string, filename: string): string => {
    // Ensure the path follows the exact structure: users/{userId}/logo/{originalFilename}
    return `users/${userId}/logo/${filename}`;
};

// Helper function to get full S3 URL for organization logo
export const getOrganizationLogoUrl = (userId: string, filename: string): string => {
    return `https://${S3_BUCKET_NAME}.s3.amazonaws.com/${getOrganizationLogoPath(userId, filename)}`;
};

// Helper function to get folder path for organization
export const getOrganizationFolderPath = (userId: string): string => {
    return `users/${userId}/logo/`;
};

export default s3Client;
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, GetCommand, QueryCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const region = import.meta.env.VITE_AWS_REGION;
const accessKeyId = import.meta.env.VITE_AWS_ACCESS_KEY_ID;
const secretAccessKey = import.meta.env.VITE_AWS_SECRET_ACCESS_KEY;

// Initialize the DynamoDB client
const client = new DynamoDBClient({
    region,
    credentials: {
        accessKeyId: accessKeyId || '',
        secretAccessKey: secretAccessKey || ''
    }
});

// Create a document client for easier interaction with DynamoDB
export const docClient = DynamoDBDocumentClient.from(client);

// Table name for storing user credentials
export const USERS_TABLE = 'Users';

// Table name for storing attendee-organization relationships
export const ATTENDEE_ORG_TABLE = 'Attendee-org';

// Function to store user credentials
export const storeUserCredentials = async (userData: {
    userId: string;
    email: string;
    name: string;
    mobile: string;
    role?: string | null;
    createdEvents?: string[];
    organizationName?: string;
    organizationCode?: string;
    organizationLogo?: string;
}) => {
    try {
        // If createdEvents is provided, use UpdateCommand to append to the array
        if (userData.createdEvents && userData.createdEvents.length > 0) {
            // Need to check if user already exists and if we need to update or create
            const existingUser = await getUserByEmail(userData.userId);
            
            // If user exists, we'll append to the array
            if (existingUser) {
                console.log('User exists, updating with new createdEvents:', userData.createdEvents);
                
                // Update only specific fields while preserving others
                const updateCommand = new UpdateCommand({
                    TableName: USERS_TABLE,
                    Key: {
                        userId: userData.userId
                    },
                    UpdateExpression: 'SET updatedAt = :updatedAt, #role = :role, #name = :name, #mobile = :mobile, organizationName = :organizationName, organizationCode = :organizationCode, organizationLogo = :organizationLogo',
                    ExpressionAttributeValues: {
                        ':updatedAt': new Date().toISOString(),
                        ':role': userData.role || existingUser.role || null,
                        ':name': userData.name,
                        ':mobile': userData.mobile,
                        ':organizationName': userData.organizationName || existingUser?.organizationName || undefined,
                        ':organizationCode': userData.organizationCode || existingUser?.organizationCode || undefined,
                        ':organizationLogo': userData.organizationLogo || existingUser?.organizationLogo || undefined
                    },
                    ExpressionAttributeNames: {
                        '#role': 'role',
                        '#name': 'name',
                        '#mobile': 'mobile'
                    }
                });
                
                // Execute the update command for user info
                await docClient.send(updateCommand);
                
                // Now handle the createdEvents array separately
                // We need to update the createdEvents array while avoiding duplicates
                let updatedEventIds = [...userData.createdEvents];
                
                // If user already has createdEvents, merge them
                if (existingUser.createdEvents && Array.isArray(existingUser.createdEvents)) {
                    // Create a Set to automatically remove duplicates
                    const eventIdSet = new Set([...existingUser.createdEvents, ...userData.createdEvents]);
                    updatedEventIds = Array.from(eventIdSet);
                }
                
                console.log('Final createdEvents array after merging:', updatedEventIds);
                
                // Update the createdEvents array
                const eventUpdateCommand = new UpdateCommand({
                    TableName: USERS_TABLE,
                    Key: {
                        userId: userData.userId
                    },
                    UpdateExpression: 'SET createdEvents = :createdEvents',
                    ExpressionAttributeValues: {
                        ':createdEvents': updatedEventIds
                    }
                });
                
                await docClient.send(eventUpdateCommand);
                return true;
            }
            
            // If user doesn't exist, create new record with all fields
            const command = new PutCommand({
                TableName: USERS_TABLE,
                Item: {
                    userId: userData.userId,
                    email: userData.email,
                    name: userData.name,
                    mobile: userData.mobile,
                    role: userData.role || null,
                    createdEvents: userData.createdEvents,
                    organizationName: userData.organizationName || undefined,
                    organizationCode: userData.organizationCode || undefined,
                    organizationLogo: userData.organizationLogo || undefined,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString()
                }
            });
            
            await docClient.send(command);
            return true;
        }

        // For updates without createdEvents, use PutCommand but preserve existing createdEvents
        const existingUser = await getUserByEmail(userData.userId);
        
        const command = new PutCommand({
            TableName: USERS_TABLE,
            Item: {
                userId: userData.userId,
                email: userData.email,
                name: userData.name,
                mobile: userData.mobile,
                role: userData.role || null,
                createdEvents: existingUser?.createdEvents || null,
                organizationName: userData.organizationName || existingUser?.organizationName || undefined,
                // Preserve existing organization code if it exists and no new one is provided
                organizationCode: existingUser?.organizationCode || userData.organizationCode || undefined,
                organizationLogo: userData.organizationLogo || existingUser?.organizationLogo || undefined,
                createdAt: existingUser?.createdAt || new Date().toISOString(),
                updatedAt: new Date().toISOString()
            }
        });

        await docClient.send(command);
        return true;
    } catch (error) {
        console.error('Error storing user credentials:', error);
        return false;
    }
};

// Function to get user credentials by email
export const getUserByEmail = async (email: string) => {
    const command = new GetCommand({
        TableName: USERS_TABLE,
        Key: {
            userId: email // Using email as userId based on how storeUserCredentials is implemented
        }
    });

    try {
        console.log(`Getting user by email: ${email}`);
        const response = await docClient.send(command);
        console.log('DynamoDB response:', response);
        return response.Item;
    } catch (error) {
        console.error('Error getting user credentials:', error);
        return null;
    }
};

// Function to query user by email since email might not be the primary key
export const queryUserByEmail = async (email: string) => {
    const { ScanCommand } = await import('@aws-sdk/lib-dynamodb');
    
    const command = new ScanCommand({
        TableName: USERS_TABLE,
        FilterExpression: 'email = :email',
        ExpressionAttributeValues: {
            ':email': email
        },
        Limit: 1
    });

    try {
        const response = await docClient.send(command);
        return response.Items?.[0] || null;
    } catch (error) {
        console.error('Error scanning for user by email:', error);
        return null;
    }
};

// Add this new function to query by organization code
export const queryUserByOrganizationCode = async (organizationCode: string) => {
  try {
    const command = new ScanCommand({
      TableName: USERS_TABLE,
      FilterExpression: 'organizationCode = :orgCode',
      ExpressionAttributeValues: {
        ':orgCode': organizationCode
      }
    });

    const response = await docClient.send(command);

    if (response.Items && response.Items.length > 0) {
      const organization = response.Items[0];
      return {
        organizationCode: organization.organizationCode,
        organizationName: organization.organizationName,
        organizationLogo: organization.organizationLogo
      };
    }
    return null;
  } catch (error) {
    console.error('Error scanning for organization by code:', error);
    throw error;
  }
};

// Function to store attendee-organization relationship
export const storeAttendeeOrg = async (data: {
  userId: string;
  organizationCode: string;
}) => {
  try {
    const command = new PutCommand({
      TableName: ATTENDEE_ORG_TABLE,
      Item: {
        userId: data.userId,
        organizationCode: data.organizationCode,
        joinedAt: new Date().toISOString()
      }
    });

    await docClient.send(command);
    return true;
  } catch (error) {
    console.error('Error storing attendee-org relationship:', error);
    return false;
  }
};

// Function to get all organizations for an attendee
export const getAttendeeOrganizations = async (userId: string) => {
  try {
    const command = new ScanCommand({
      TableName: ATTENDEE_ORG_TABLE,
      FilterExpression: 'userId = :userId',
      ExpressionAttributeValues: {
        ':userId': userId
      }
    });

    const response = await docClient.send(command);
    
    if (response.Items && response.Items.length > 0) {
      // Fetch organization details for each organization code
      const organizationPromises = response.Items.map(async (item) => {
        const orgDetails = await queryUserByOrganizationCode(item.organizationCode);
        if (orgDetails) {
          return {
            ...orgDetails,
            joinedAt: item.joinedAt
          };
        }
        return null;
      });

      const organizations = await Promise.all(organizationPromises);
      return organizations.filter(org => org !== null); // Remove any null entries
    }
    return [];
  } catch (error) {
    console.error('Error getting attendee organizations:', error);
    return [];
  }
};

// Function to get events by organization code
export const getEventsByOrganizationCode = async (organizationCode: string) => {
  try {
    const command = new ScanCommand({
      TableName: 'Events',
      FilterExpression: 'organizationCode = :orgCode',
      ExpressionAttributeValues: {
        ':orgCode': organizationCode
      }
    });

    const response = await docClient.send(command);
    
    if (response.Items && response.Items.length > 0) {
      return response.Items.map(event => ({
        id: event.id,
        name: event.name,
        date: event.date,
        coverImage: event.coverImage,
        thumbnailUrl: event.thumbnailUrl || event.coverImage
      }));
    }
    return [];
  } catch (error) {
    console.error('Error getting events by organization code:', error);
    return [];
  }
};

// Function to store attendee image data
export const storeAttendeeImageData = async (data: {
  userId: string;
  eventId: string;
  selfieURL: string;
  matchedImages: string[];
  uploadedAt: string;
  lastUpdated: string;
}) => {
  try {
    const command = new PutCommand({
      TableName: 'Attendee-imgs',
      Item: {
        userId: data.userId,
        eventId: data.eventId,
        selfieURL: data.selfieURL,
        matchedImages: data.matchedImages,
        uploadedAt: data.uploadedAt,
        lastUpdated: data.lastUpdated
      }
    });

    await docClient.send(command);
    return true;
  } catch (error) {
    console.error('Error storing attendee image data:', error);
    return false;
  }
};

// Function to get attendee's selfie URL
export const getAttendeeSelfieURL = async (userId: string) => {
  try {
    const command = new QueryCommand({
      TableName: 'Attendee-imgs',
      KeyConditionExpression: 'userId = :userId',
      ExpressionAttributeValues: {
        ':userId': userId
      },
      Limit: 1 // We just need the most recent one
    });

    const response = await docClient.send(command);
    
    if (response.Items && response.Items.length > 0) {
      return response.Items[0].selfieURL;
    }
    return null;
  } catch (error) {
    console.error('Error getting attendee selfie URL:', error);
    return null;
  }
};

// Function to get matched images for a user and event
export const getMatchedImages = async (userId: string, eventId: string) => {
  try {
    const command = new QueryCommand({
      TableName: 'Attendee-imgs',
      KeyConditionExpression: 'userId = :userId AND eventId = :eventId',
      ExpressionAttributeValues: {
        ':userId': userId,
        ':eventId': eventId
      }
    });

    const response = await docClient.send(command);
    
    if (response.Items && response.Items.length > 0) {
      // Return the matched images array and other relevant data
      const item = response.Items[0];
      return {
        matchedImages: item.matchedImages,
        selfieURL: item.selfieURL,
        uploadedAt: item.uploadedAt,
        lastUpdated: item.lastUpdated
      };
    }
    return null;
  } catch (error) {
    console.error('Error getting matched images:', error);
    return null;
  }
};

// Function to get events through user table by organization code
export const getEventsViaUserByOrgCode = async (organizationCode: string) => {
  try {
    // First, find users with this organization code
    const userCommand = new ScanCommand({
      TableName: USERS_TABLE,
      FilterExpression: 'organizationCode = :orgCode',
      ExpressionAttributeValues: {
        ':orgCode': organizationCode
      }
    });

    const userResponse = await docClient.send(userCommand);
    
    if (!userResponse.Items || userResponse.Items.length === 0) {
      console.error('No users found with organization code:', organizationCode);
      return [];
    }

    // Get the userId from the first user with this org code
    const userId = userResponse.Items[0].userId;

    // Now get events for this userId
    const eventCommand = new ScanCommand({
      TableName: 'Events',
      FilterExpression: 'userId = :userId',
      ExpressionAttributeValues: {
        ':userId': userId
      }
    });

    const eventResponse = await docClient.send(eventCommand);
    
    if (eventResponse.Items && eventResponse.Items.length > 0) {
      return eventResponse.Items.map(event => ({
        id: event.id,
        name: event.name,
        date: event.date,
        coverImage: event.coverImage,
        thumbnailUrl: event.thumbnailUrl || event.coverImage
      }));
    }
    return [];
  } catch (error) {
    console.error('Error getting events via user by organization code:', error);
    return [];
  }
};
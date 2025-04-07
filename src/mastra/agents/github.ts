import { Agent } from '@mastra/core/agent'
import { anthropic } from '@ai-sdk/anthropic'
import { Arcade } from '@arcadeai/arcadejs'
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

// Utility to convert JSON Schema (used by Arcade/OpenAI) to Zod schemas (used by Mastra)
import { JSONSchemaToZod } from '@dmitryrechkin/json-schema-to-zod';

// Initialize the Arcade client to interact with the Arcade API
const arcade = new Arcade();

// Define a constant User ID. In a real application, this would likely be dynamic
// and represent the currently logged-in user interacting with the agent.
// It's used by Arcade for application-level authorization checks.
const USER_ID = "user@example.com";

/**
 * Defines the minimum expected structure of a tool definition fetched from Arcade.
 * This schema ensures we only process tools that have the necessary fields
 * (name, parameters schema, description) required for creating a Mastra tool.
 * We use Zod for robust validation.
 */
const arcadeToolMinimumSchema = z.object({
  function: z.object({
    name: z.string(), // The unique identifier/name of the tool.
    parameters: z.record(z.any()), // The JSON Schema definition for the tool's input parameters.
    description: z.string() // A description of what the tool does, used by the AI model.
  })
})

/**
 * Asynchronously retrieves tools from the Arcade platform, optionally filtered by a toolkit,
 * and transforms them into the format required by the Mastra Agent's `tools` property.
 */
async function getArcadeMastraTools({ toolkit, user_id }: { toolkit?: string; user_id: string }) {
  // Fetch the list of available tools from Arcade, requesting the OpenAI format
  // which includes the necessary function name, description, and parameters schema.
  const tools = await arcade.tools.formatted.list({
    ...(toolkit && { toolkit }), // Conditionally include the toolkit filter if provided.
    format: 'openai' // Specify the desired format for tool definitions.
  });

  // Process the fetched tools, converting each valid one into a Mastra tool.
  return tools.items.reduce((acc: Record<string, ReturnType<typeof createTool>>, item) => {
    // Validate the structure of the fetched tool definition against our minimum schema.
    const parsedItem = arcadeToolMinimumSchema.safeParse(item);

    // If the tool definition is valid, proceed to create a Mastra tool.
    if (parsedItem.success) {
      const { name, description, parameters } = parsedItem.data.function;

      // Add the tool to the accumulator object, keyed by its name.
      acc[name] = createTool({
        id: name, // Use the Arcade tool name as the Mastra tool ID.
        description, // Use the Arcade tool description.
        // Convert the JSON Schema parameters definition from Arcade to a Zod schema for Mastra.
        inputSchema: JSONSchemaToZod.convert(parameters),
        // Define the execution logic for this tool when called by the Mastra agent.
        execute: async ({ context }) => {
          try {
            // Attempt to execute the tool via the Arcade API, passing the input context
            // and the user ID for authorization.
            const result = await arcade.tools.execute({
              tool_name: name,
              input: context, // `context` contains the validated input arguments provided by the agent.
              user_id,
            });
            // Return the successful result from the Arcade tool execution.
            return result;
          } catch (error) {
            // Handle potential errors during tool execution.
            // Specifically check if the error indicates a need for user authorization.
            if (error instanceof Error && isAuthorizationRequiredError(error)) {
              // If authorization is required, request an authorization URL from Arcade.
              const response = await getAuthorizationResponse(name, user_id);
              // Return a specific structure indicating authorization is needed,
              // including the URL the user must visit. The agent's instructions
              // should guide it on how to present this URL to the user.
              return { authorization_required: true, url: response.url, message: 'Forward this url to the user for authorization' };
            }
            // If it's a different type of error, re-throw it to be handled elsewhere.
            throw error;
          }
        }
      })
    } else {
      // Log a warning if a fetched tool definition doesn't match the expected schema.
      console.warn(`Skipping tool due to invalid schema: ${JSON.stringify(item)}`, parsedItem.error);
    }

    // Return the accumulator for the next iteration.
    return acc;
  }, {} as Record<string, ReturnType<typeof createTool>>); // Initialize with an empty object typed correctly.
}

/**
 * Checks if a given error object signifies that user authorization is required
 * to execute the Arcade tool. This is based on common error names or messages
 * returned by Arcade or underlying services when permissions are missing.
 */
function isAuthorizationRequiredError(error: Error) {
  // Check for specific error names or message content patterns.
  return error?.name === "PermissionDeniedError" ||
    error?.message?.includes("permission denied") ||
    error?.message?.includes("authorization required");
}

/**
 * Calls the Arcade API to initiate the authorization flow for a specific tool
 * and user. This typically returns a URL that the user needs to visit to grant
 * the necessary permissions.
 */
async function getAuthorizationResponse(toolName: string, user_id: string) {
  // Request authorization from Arcade for the specified tool and user.
  return await arcade.tools.authorize({
    tool_name: toolName,
    user_id,
  });
}

// --- Agent Definition ---

// Asynchronously fetch and prepare the Arcade tools before creating the agent instance.
// This ensures the agent is initialized with all its tools ready.
const arcadeTools = await getArcadeMastraTools({ toolkit: 'github', user_id: USER_ID });

// Export the configured Mastra Agent instance.
export const githubAgent = new Agent({
  name: "githubAgent", // A descriptive name for the agent.
  // Instructions guiding the AI model on its role, capabilities, and how to handle specific situations
  // like tool authorization failures.
  instructions: "You are a GitHub Agent that can help with code-related tasks using available tools. If a tool requires authorization, you will receive an authorization URL. Please present this URL clearly to the user and instruct them to visit it to grant permissions.",
  // Specify the AI model to power the agent.
  model: anthropic('claude-3-7-sonnet-20250219'),
  // Provide the prepared tools fetched and formatted from Arcade.
  tools: arcadeTools,
});

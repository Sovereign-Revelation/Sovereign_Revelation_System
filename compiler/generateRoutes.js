const fs = require('fs').promises;
const path = require('path');

async function generateRoutes() {
  const schemaPath = path.resolve(__dirname, '../schema/api/api.schema.json');
  const outputPath = path.resolve(__dirname, '../routes/generatedRoutes.js');

  let apiSchema;
  try {
    const schemaData = await fs.readFile(schemaPath, 'utf-8');
    apiSchema = JSON.parse(schemaData);
  } catch (e) {
    console.error(`❌ Could not load schema: ${e.message}`);
    process.exit(1);
  }

  const endpoints = [];
  const modules = apiSchema.properties || {};

  for (const [moduleName, moduleSchema] of Object.entries(modules)) {
    const actions = moduleSchema.properties || {};
    for (const [actionName, actionSchema] of Object.entries(actions)) {
      endpoints.push({
        path: `/${moduleName}/${actionName}`,
        method: 'POST',
        workflow: `${moduleName}-${actionName}`,
        description: `${actionName} action for ${moduleName} module`
      });
    }
  }

  let routeContent = `
// Auto-generated routes from schema
const express = require('express');
const router = express.Router();
const { executeJSONFlow } = require('../jsonflow-executor');

`;

  for (const endpoint of endpoints) {
    const { path: endpointPath, method, workflow, description } = endpoint;
    routeContent += `
/**
 * ${description}
 * Method: ${method}
 * Endpoint: ${endpointPath}
 */
router.${method.toLowerCase()}('${endpointPath}', async (req, res) => {
  try {
    const data = req.body || {};
    const result = await executeJSONFlow({
      workflow: '${workflow}',
      params: data
    });
    res.json({ success: true, result });
  } catch (error) {
    console.error('❌ Flow Execution Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});
`;
  }

  routeContent += `

module.exports = router;
`;

  try {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, routeContent.trim() + '\n');
    console.log(`✅ Generated routes at: ${outputPath}`);
  } catch (error) {
    console.error(`❌ Failed to write routes: ${error.message}`);
    process.exit(1);
  }
}

generateRoutes();
import fetch from 'node-fetch';
import fs from 'fs/promises';

const repositories = [
  'jackocnr/intl-tel-input',
  'cure53/DOMPurify',
  'chartjs/Chart.js',
  'Choices-js/Choices',
];

const CACHE_FILE = 'checked_versions.json';

async function loadCache() {
  try {
    const data = await fs.readFile(CACHE_FILE, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    return {};
  }
}

async function saveCache(cache) {
  try {
    await fs.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch (err) {
    console.error('Error saving cache:', err.message);
  }
}

async function fetchRepositoryData(repoName) {
  const url = `https://api.github.com/repos/${repoName}/releases`;

  const response = await fetch(url);

  if (!response.ok) {
    console.error(`Error fetching data for ${repoName}: ${response.statusText}`);
    return null;
  }

  const releases = await response.json();
  return releases[0] || null;
}

async function sendToSlack(message) {
  const url = process.env.SLACK_WEBHOOK;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: message }),
  });

  if (!response.ok) {
    console.error(`Error sending message to Slack: ${response.statusText}`);
  }
}

async function callGPTAPI(description, repo, version, url) {
  const apiUrl = 'https://api.openai.com/v1/chat/completions';

  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: `
            You're a WPForms Developer trying to determine the significance of a new library update.
            Here's a release description/changelog for evaluation: "${description}"
            
            Please provide a structured JSON output with the following keys:
            - "library": ${repo}
            - "version": ${version}
            - "URL": ${url}
            - "severity": One of "low", "medium", or "high" indicating the importance of the update.
            - "ai-summary": A brief AI-generated summary of the release.
            
            Example response (return only clean and valid JSON text):
            {
              "library": "example-library",
              "version": "1.2.3",
              "URL": "https://example.com",
              "severity": "medium",
              "ai-summary": "This release fixes several security vulnerabilities."
            }
          `,
        },
      ],
    }),
  });

  if (!response.ok) {
    console.error(`Error calling OpenAI API: ${response.statusText}`);
    return 'Failed to evaluate with AI.';
  }

  const json = await response.json();
  const structuredOutput = json.choices[0].message.content;

  console.log(json);
  console.log(structuredOutput);
  console.log('---');
  
  return JSON.parse(structuredOutput);
}

(async () => {
  const cache = await loadCache();

  // console.log(cache);

  for (const repo of repositories) {
    const release = await fetchRepositoryData(repo);

    if (release) {
      const { tag_name, html_url, body } = release;

      // Skip if version already checked
      if (cache[repo] === tag_name) {
        console.log(`Version ${tag_name} of ${repo} is already checked. Skipping.`);
        continue;
      }

      const aiAnalysis = await callGPTAPI(body, repo, tag_name, html_url);
      // console.log(aiAnalysis);

      if (aiAnalysis && (aiAnalysis.severity === 'low' || aiAnalysis.severity === 'medium' || aiAnalysis.severity === 'high')) {
        const message = `
          :wave: Update detected for ${repo}!
          - **Version:** ${tag_name}
          - **URL:** ${html_url}
          - **Severity:** ${aiAnalysis.severity.toUpperCase()}
          - **Summary:** ${aiAnalysis['ai-summary']}
        `;

        await sendToSlack(message);
      }
      
      // Update cache
      cache[repo] = tag_name;
      await saveCache(cache);
    }
  }
})();

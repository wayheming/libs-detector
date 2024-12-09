import fetch from 'node-fetch';
import fs from 'fs/promises';

const repositories = [
  'jackocnr/intl-tel-input',
  'cure53/DOMPurify',
  'chartjs/Chart.js',
  'Choices-js/Choices',
  'WordPress/plugin-check',
];

const CACHE_FILE = 'checked_versions_4.json';

// Load the cache file if it exists, or create an empty object.
async function loadCache() {
  try {
    const data = await fs.readFile(CACHE_FILE, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    return {};
  }
}

// Save the cache object to a file.
async function saveCache(cache) {
  try {
    await fs.writeFile(CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch (err) {
    console.error('Error saving cache:', err.message);
  }
}

// Fetch the latest release data for a repository.
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

// Send a message to a Slack channel.
async function sendToSlack(message) {
  const url = process.env.SLACK_WEBHOOK;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      data: message
    }),
  });

  if (!response.ok) {
    console.error(`Error sending message to Slack: ${response.statusText}`);
  }
}

// Call the OpenAI API to analyze a release description.
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

           Return only clean and valid JSON text without.
           Give me the response without JSON formatting.
            
            Example response:
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
  
  return JSON.parse(structuredOutput);
}

// Create a new issue on a GitHub repository.
async function createGitHubIssue(title, body) {
  const token = process.env.GITHUB_TOKEN;
  const url = `https://api.github.com/repos/wayheming/libs-detector/issues`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      title: title,
      body: body,
    }),
  });

  if (!response.ok) {
    console.error(`Failed to create issue: ${response.status} ${response.statusText}`);
    const errorDetails = await response.json();
    console.error(errorDetails);
    throw new Error('Error creating GitHub issue');
  }

  const issueData = await response.json();
  console.log(`Issue created: ${issueData.html_url}`);
}

// Main function to check for updates.
(async () => {
  const cache = await loadCache();

  for (const repo of repositories) {
    const release = await fetchRepositoryData(repo);

    if (!release) {
      console.log(`No release data found for ${repo}.`);
      continue;
    }

    const { tag_name, html_url, body } = release;

    if (cache[repo] && cache[repo].includes(tag_name)) {
      console.log(`Version ${tag_name} of ${repo} is already checked. Skipping.`);
      continue;
    }

    let aiAnalysis;
    try {
      aiAnalysis = await callGPTAPI(body, repo, tag_name, html_url);
    } catch (err) {
      console.error(`Error analyzing release with AI for ${repo}:`, err.message);
      continue;
    }

    if (aiAnalysis) {
      const message = `
:wave: Important release detected for ${repo}!
:card_index_dividers: Version: ${tag_name}
:link: URL: ${html_url}
:closed_lock_with_key: Severity: ${aiAnalysis.severity.toUpperCase()}
:ai: AI Summary: ${aiAnalysis['ai-summary']}
`;
      try {
        await sendToSlack(message);
      } catch (err) {
        console.error(`Error sending message to Slack for ${repo}:`, err.message);
        continue;
      }
      
      if (['medium', 'high'].includes(aiAnalysis.severity)) {
        try {
          await createGitHubIssue(repo, message);
        } catch (err) {
          console.error(`Error creating issue for ${repo}:`, err.message);
          continue;
        }
      }
    }

    if (!cache[repo]) {
      cache[repo] = [];
    }
    cache[repo].push(tag_name);
    await saveCache(cache);
  }
})();

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
  сonsole.log(cache);
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
    body: JSON.stringify({ data: message }),
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

  console.log(repo);
  console.log(structuredOutput);
  console.log('---');
  
  return JSON.parse(structuredOutput);
}

(async () => {
  const cache = await loadCache();

  console.log(cache);

  for (const repo of repositories) {
    try {
      const release = await fetchRepositoryData(repo);
  
      if (!release) {
        console.log(`No release data found for ${repo}.`);
        continue;
      }
  
      const { tag_name, html_url, body } = release;
  
      // Перевірка кешу
      if (cache[repo] === tag_name) {
        console.log(`Version ${tag_name} of ${repo} is already checked. Skipping.`);
        continue;
      }
  
      // Аналіз AI
      let aiAnalysis;
      try {
        aiAnalysis = await callGPTAPI(body, repo, tag_name, html_url);
      } catch (err) {
        console.error(`Error analyzing release with AI for ${repo}:`, err.message);
        continue;
      }
  
      if (aiAnalysis && ['low', 'medium', 'high'].includes(aiAnalysis.severity)) {
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
        }
      }
  
      // Оновлення кешу
      cache[repo] = tag_name;
      await saveCache(cache);
    } catch (err) {
      console.error(`Error processing repository ${repo}:`, err.message);
    }
  }
})();

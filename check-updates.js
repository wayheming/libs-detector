import fetch from 'node-fetch';

const repositories = [
  'jackocnr/intl-tel-input',
  'cure53/DOMPurify',
  'chartjs/Chart.js',
  'Choices-js/Choices',
];

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

async function callGPTAPI(description) {
  const url = 'https://api.openai.com/v1/chat/completions';

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4',
      messages: [
        {
          role: 'user',
          content: `Hi! Evaluate this release description for critical updates, security patches, and a brief summary: ${description}`,
        },
      ],
    }),
  });

  if (!response.ok) {
    console.error(`Error calling OpenAI API: ${response.statusText}`);
    return 'Failed to evaluate with AI.';
  }

  const json = await response.json();
  return json.choices[0].message.content;
}

(async () => {
  for (const repo of repositories) {
    const release = await fetchRepositoryData(repo);

    if (release) {
      const aiAnalysis = await callGPTAPI(release.body);

      const message = `
        :wave: Update detected for ${repo}!
        - **Version:** ${release.tag_name}
        - **Date:** ${release.published_at}
        - **URL:** ${release.html_url}
        - **AI Analysis:** ${aiAnalysis}
      `;

      console.log(message);

      //await sendToSlack(message);
    }
  }
})();

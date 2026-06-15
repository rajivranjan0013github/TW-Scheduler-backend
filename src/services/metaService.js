/**
 * Publishes a post to Instagram (Reels or Image Feed Posts)
 * @param {string} accessToken - Instagram/Facebook access token
 * @param {string} instagramBusinessAccountId - Target Instagram Business Account ID
 * @param {string} mediaUrl - Public url of the media file (e.g. from Cloudflare R2)
 * @param {string} mediaType - 'image' or 'video'
 * @param {string} caption - Post caption
 * @returns {Promise<string>} - Published Meta Media ID
 */
export const publishToInstagram = async (accessToken, instagramBusinessAccountId, mediaUrl, mediaType, caption) => {
  const isVideo = mediaType === 'video';
  const apiVersion = 'v20.0';
  const baseUrl = `https://graph.facebook.com/${apiVersion}`;

  console.log(`🤖 [Meta Service] Initializing Instagram upload to account: ${instagramBusinessAccountId}`);
  
  // Step 1: Create the media container
  const containerUrl = `${baseUrl}/${instagramBusinessAccountId}/media`;
  const containerParams = {
    caption: caption || '',
    access_token: accessToken,
  };

  if (isVideo) {
    containerParams.media_type = 'REELS';
    containerParams.video_url = mediaUrl;
    containerParams.share_to_feed = 'true';
  } else {
    containerParams.image_url = mediaUrl;
  }

  const containerRes = await fetch(containerUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(containerParams)
  });

  const containerData = await containerRes.json();

  if (!containerRes.ok || !containerData.id) {
    console.error('❌ Instagram Media Container Creation Failed:', containerData);
    throw new Error(containerData.error?.message || 'Failed to create Instagram media container');
  }

  const containerId = containerData.id;
  console.log(`📦 Instagram Media Container created successfully. ID: ${containerId}. Starting status polling...`);

  // Step 2: Poll status of the container (required for video/reels, good practice for images)
  const pollUrl = `${baseUrl}/${containerId}?fields=status_code,error_info&access_token=${accessToken}`;
  const maxAttempts = 30; // 30 attempts * 5s = 150 seconds max wait
  let attempt = 0;
  let finished = false;

  while (attempt < maxAttempts && !finished) {
    attempt++;
    console.log(`⏳ [Attempt ${attempt}/${maxAttempts}] Checking Instagram container status...`);
    
    // Wait 5 seconds
    await new Promise(resolve => setTimeout(resolve, 5000));

    const pollRes = await fetch(pollUrl);
    const pollData = await pollRes.json();

    if (!pollRes.ok) {
      console.error('❌ Instagram Container Poll Failed:', pollData);
      throw new Error(pollData.error?.message || 'Error checking container status');
    }

    const statusCode = pollData.status_code;
    console.log(`📡 Container status code: ${statusCode}`);

    if (statusCode === 'FINISHED') {
      finished = true;
    } else if (statusCode === 'ERROR') {
      console.error('❌ Instagram Container Processing Error:', pollData.error_info);
      throw new Error(pollData.error_info || 'Instagram media container processing failed');
    }
  }

  if (!finished) {
    throw new Error('Timeout waiting for Instagram media container to finish processing');
  }

  console.log(`✨ Instagram Container ready. Publishing container: ${containerId}...`);

  // Step 3: Publish the container
  const publishUrl = `${baseUrl}/${instagramBusinessAccountId}/media_publish`;
  const publishRes = await fetch(publishUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      creation_id: containerId,
      access_token: accessToken,
    })
  });

  const publishData = await publishRes.json();

  if (!publishRes.ok || !publishData.id) {
    console.error('❌ Instagram Publishing Failed:', publishData);
    throw new Error(publishData.error?.message || 'Failed to publish media container');
  }

  console.log(`🎉 Instagram Post published successfully! ID: ${publishData.id}`);
  return publishData.id;
};

/**
 * Publishes a post to Facebook Page (Feed or Video posts)
 * @param {string} accessToken - Facebook Page Access Token
 * @param {string} pageId - Target Facebook Page ID
 * @param {string} mediaUrl - Public url of the media file (optional)
 * @param {string} mediaType - 'image' or 'video' (optional)
 * @param {string} caption - Post message
 * @returns {Promise<string>} - Published Facebook post ID
 */
export const publishToFacebook = async (accessToken, pageId, mediaUrl, mediaType, caption) => {
  const apiVersion = 'v20.0';
  const baseUrl = `https://graph.facebook.com/${apiVersion}`;

  console.log(`🤖 [Meta Service] Initializing Facebook Page upload to Page ID: ${pageId}`);

  let publishUrl = `${baseUrl}/${pageId}/feed`;
  let params = {
    message: caption || '',
    access_token: accessToken,
  };

  if (mediaUrl) {
    if (mediaType === 'video') {
      // Publish to Page Video Feed
      publishUrl = `${baseUrl}/${pageId}/videos`;
      params = {
        description: caption || '',
        file_url: mediaUrl,
        access_token: accessToken,
      };
    } else {
      // Publish to Page Photos
      publishUrl = `${baseUrl}/${pageId}/photos`;
      params = {
        message: caption || '',
        url: mediaUrl,
        access_token: accessToken,
      };
    }
  }

  const response = await fetch(publishUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params)
  });

  const data = await response.json();

  if (!response.ok || (!data.id && !data.post_id)) {
    console.error('❌ Facebook Publishing Failed:', data);
    throw new Error(data.error?.message || 'Failed to publish to Facebook Page');
  }

  const publishedId = data.post_id || data.id;
  console.log(`🎉 Facebook Post published successfully! ID: ${publishedId}`);
  return publishedId;
};

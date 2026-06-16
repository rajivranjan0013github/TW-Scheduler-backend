const getMetaErrorMessage = (stage, response, data) => {
  const error = data?.error || {};
  const details = [
    `${stage} failed`,
    `status=${response.status}`,
    error.message ? `message="${error.message}"` : null,
    error.type ? `type=${error.type}` : null,
    error.code ? `code=${error.code}` : null,
    error.error_subcode ? `subcode=${error.error_subcode}` : null,
    error.fbtrace_id ? `fbtrace_id=${error.fbtrace_id}` : null,
  ].filter(Boolean);

  return details.join(' | ');
};

const logInstagramRequest = (stage, context) => {
  console.log(`🤖 [Instagram Publish:${stage}]`, {
    graphHost: context.graphHost,
    accountId: context.accountId,
    authProvider: context.authProvider,
    mediaType: context.mediaType,
    mediaUrl: context.mediaUrl,
    captionLength: context.captionLength,
    tokenPrefix: context.accessToken ? `${context.accessToken.slice(0, 12)}...` : null,
    tokenLength: context.accessToken?.length || 0,
  });
};

/**
 * Publishes a post to Instagram (Reels or Image Feed Posts)
 * @param {string} accessToken - Instagram/Facebook access token
 * @param {string} instagramBusinessAccountId - Target Instagram Business Account ID
 * @param {string} mediaUrl - Public url of the media file (e.g. from Cloudflare R2)
 * @param {string} mediaType - 'image' or 'video'
 * @param {string} caption - Post caption
 * @param {string} authProvider - 'facebook' for Page-linked tokens, 'instagram' for direct Instagram Login tokens
 * @returns {Promise<string>} - Published Meta Media ID
 */
export const publishToInstagram = async (accessToken, instagramBusinessAccountId, mediaUrl, mediaType, caption, authProvider = 'facebook') => {
  const isVideo = mediaType === 'video';
  const apiVersion = 'v20.0';
  const graphHost = authProvider === 'instagram' ? 'graph.instagram.com' : 'graph.facebook.com';
  const baseUrl = `https://${graphHost}/${apiVersion}`;

  console.log(`🤖 [Meta Service] Initializing Instagram upload to account: ${instagramBusinessAccountId}`);
  logInstagramRequest('container-create', {
    graphHost,
    accountId: instagramBusinessAccountId,
    authProvider,
    mediaType,
    mediaUrl,
    captionLength: caption?.length || 0,
    accessToken,
  });
  
  // Step 1: Create the media container
  const containerUrl = `${baseUrl}/${instagramBusinessAccountId}/media`;
  const containerParams = new URLSearchParams();
  containerParams.append('caption', caption || '');
  containerParams.append('access_token', accessToken);

  if (isVideo) {
    containerParams.append('media_type', 'REELS');
    containerParams.append('video_url', mediaUrl);
    containerParams.append('share_to_feed', 'true');
  } else {
    containerParams.append('image_url', mediaUrl);
  }

  const containerRes = await fetch(containerUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: containerParams
  });

  const containerData = await containerRes.json();

  if (!containerRes.ok || !containerData.id) {
    const message = getMetaErrorMessage('Instagram media container creation', containerRes, containerData);
    console.error('❌ Instagram Media Container Creation Failed:', {
      status: containerRes.status,
      url: containerUrl,
      graphHost,
      accountId: instagramBusinessAccountId,
      authProvider,
      mediaType,
      mediaUrl,
      response: containerData,
    });
    throw new Error(message);
  }

  const containerId = containerData.id;
  console.log(`📦 Instagram Media Container created successfully. ID: ${containerId}. Starting status polling...`);

  // Step 2: Poll status of the container (required for video/reels, good practice for images)
  const pollFields = authProvider === 'instagram' ? 'status_code' : 'status_code,error_info';
  const pollUrl = `${baseUrl}/${containerId}?fields=${pollFields}&access_token=${accessToken}`;
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
      const message = getMetaErrorMessage('Instagram container polling', pollRes, pollData);
      console.error('❌ Instagram Container Poll Failed:', {
        status: pollRes.status,
        url: pollUrl.replace(accessToken, '[redacted]'),
        response: pollData,
      });
      throw new Error(message);
    }

    const statusCode = pollData.status_code;
    console.log(`📡 Container status code: ${statusCode}`);

    if (statusCode === 'FINISHED') {
      finished = true;
    } else if (statusCode === 'ERROR') {
      console.error('❌ Instagram Container Processing Error:', pollData.error_info);
      throw new Error(`Instagram media container processing failed: ${JSON.stringify(pollData.error_info || pollData)}`);
    }
  }

  if (!finished) {
    throw new Error('Timeout waiting for Instagram media container to finish processing');
  }

  console.log(`✨ Instagram Container ready. Publishing container: ${containerId}...`);
  logInstagramRequest('media-publish', {
    graphHost,
    accountId: instagramBusinessAccountId,
    authProvider,
    mediaType,
    mediaUrl,
    captionLength: caption?.length || 0,
    accessToken,
  });

  // Step 3: Publish the container
  const publishUrl = `${baseUrl}/${instagramBusinessAccountId}/media_publish`;
  const publishParams = new URLSearchParams();
  publishParams.append('creation_id', containerId);
  publishParams.append('access_token', accessToken);

  const publishRes = await fetch(publishUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: publishParams
  });

  const publishData = await publishRes.json();

  if (!publishRes.ok || !publishData.id) {
    const message = getMetaErrorMessage('Instagram media publish', publishRes, publishData);
    console.error('❌ Instagram Publishing Failed:', {
      status: publishRes.status,
      url: publishUrl,
      graphHost,
      accountId: instagramBusinessAccountId,
      authProvider,
      mediaType,
      response: publishData,
    });
    throw new Error(message);
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

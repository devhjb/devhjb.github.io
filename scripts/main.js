const ARTICLE_DATA_URL = './data/articles.json';

const articleListElement = document.querySelector('#article-list');
const articleLoadStateElement = document.querySelector('#article-load-state');

const renderArticles = (articles) => {
  if (!articleListElement) {
    return;
  }

  articleListElement.innerHTML = '';

  articles.forEach((article) => {
    articleListElement.appendChild(buildArticleCard(article));
  });

  if (articleLoadStateElement) {
    articleLoadStateElement.hidden = true;
  }
};

const buildArticleCard = (article) => {
  const card = document.createElement('article');
  card.className = article.featured ? 'article-card featured' : 'article-card';

  const meta = document.createElement('div');
  meta.className = 'article-meta';
  meta.appendChild(buildTextElement('span', article.category));
  meta.appendChild(buildTextElement('span', article.status));

  const title = document.createElement('h3');
  const mainLink = article.links?.[0];
  if (mainLink?.url) {
    const link = document.createElement('a');
    link.href = mainLink.url;
    applyLinkTarget(link, mainLink.url);
    link.textContent = article.title;
    title.appendChild(link);
  } else {
    title.textContent = article.title;
  }

  const summary = buildTextElement('p', article.summary);

  const footer = document.createElement('div');
  footer.className = 'article-footer';
  footer.appendChild(buildTextElement('span', article.series));
  footer.appendChild(buildArticleLinks(article));

  card.appendChild(meta);
  card.appendChild(title);
  card.appendChild(summary);
  card.appendChild(footer);

  return card;
};

const buildArticleLinks = (article) => {
  if (!article.links || article.links.length === 0) {
    const state = document.createElement('span');
    state.className = 'pending-link';
    state.textContent = article.status === '草稿' ? '准备发布' : '链接待补';
    return state;
  }

  const links = document.createElement('span');
  links.className = 'article-links';

  article.links.forEach((item) => {
    const link = document.createElement('a');
    link.className = 'article-link';
    link.href = item.url;
    applyLinkTarget(link, item.url);
    link.textContent = item.label;
    links.appendChild(link);
  });

  return links;
};

const applyLinkTarget = (link, url) => {
  if (/^https?:\/\//.test(url)) {
    link.target = '_blank';
    link.rel = 'noreferrer';
  }
};

const buildTextElement = (tagName, text) => {
  const element = document.createElement(tagName);
  element.textContent = text;
  return element;
};

const loadArticles = async () => {
  try {
    const response = await fetch(ARTICLE_DATA_URL);
    if (!response.ok) {
      throw new Error(`Failed to load articles: ${response.status}`);
    }
    const articles = await response.json();
    renderArticles(articles);
  } catch (error) {
    console.error(error);
    if (articleLoadStateElement) {
      articleLoadStateElement.hidden = false;
      articleLoadStateElement.textContent = '文章暂时加载失败，请稍后刷新。';
    }
  }
};

loadArticles();

// DOM Elements
document.addEventListener('DOMContentLoaded', function() {
  // Theme toggle
  const themeToggle = document.createElement('button');
  themeToggle.className = 'theme-toggle';
  themeToggle.innerHTML = '<i class="fas fa-moon"></i>';
  themeToggle.setAttribute('title', 'Toggle Dark Mode');
  
  // Create header and add theme toggle
  const header = document.createElement('header');
  const pageTitle = document.querySelector('h1');
  document.body.insertBefore(header, document.body.firstChild);
  header.appendChild(pageTitle);
  header.appendChild(themeToggle);
  
  // Container wrapper
  const container = document.createElement('div');
  container.className = 'container';
  
  // Move everything except header into container
  while (document.body.children.length > 1) {
    container.appendChild(document.body.children[1]);
  }
  document.body.appendChild(container);
  
  // Convert existing form-groups to cards
  const formGroups = document.querySelectorAll('.form-group');
  formGroups.forEach(group => {
    // Get heading if exists
    const heading = group.querySelector('h3');
    if (heading) {
      const headingText = heading.textContent;
      heading.remove();
      
      // Create card structure
      group.classList.add('card');
      group.classList.remove('form-group');
      
      // Add card header with icon based on content
      let icon = 'fa-cog';
      if (headingText.includes('Proxy')) {
        icon = 'fa-network-wired';
      } else if (headingText.includes('Log')) {
        icon = 'fa-list';
      } else if (headingText.includes('Results')) {
        icon = 'fa-table';
      } else if (headingText.includes('Configuration')) {
        icon = 'fa-sliders-h';
      }
      
      const cardHeader = document.createElement('div');
      cardHeader.className = 'card-header';
      cardHeader.innerHTML = `<h3 class="card-title"><i class="fas ${icon}"></i> ${headingText}</h3>`;
      
      // If this is a collapsible section, add toggle button
      if (['Configuration', 'Proxy Configuration'].includes(headingText)) {
        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'btn btn-sm btn-secondary';
        toggleBtn.innerHTML = '<i class="fas fa-chevron-down"></i>';
        toggleBtn.onclick = function() {
          const content = this.closest('.card').querySelector('.card-content');
          content.style.display = content.style.display === 'none' ? 'block' : 'none';
          this.innerHTML = content.style.display === 'none' ? 
                          '<i class="fas fa-chevron-down"></i>' : 
                          '<i class="fas fa-chevron-up"></i>';
        };
        cardHeader.appendChild(toggleBtn);
      }
      
      // Create content wrapper
      const cardContent = document.createElement('div');
      cardContent.className = 'card-content';
      
      // Move all remaining children to content wrapper
      while (group.children.length) {
        cardContent.appendChild(group.children[0]);
      }
      
      // Reassemble the card
      group.appendChild(cardHeader);
      group.appendChild(cardContent);
    }
  });
  
  // Enhance Configuration Section
  const configInputs = document.querySelectorAll('#concurrency, #depth, #delay, #timeout, #maxPages');
  configInputs.forEach(input => {
    const parent = input.parentElement;
    parent.classList.add('input-group');
  });
  
  const checkboxes = document.querySelectorAll('input[type="checkbox"]');
  checkboxes.forEach(checkbox => {
    const parent = checkbox.parentElement;
    parent.classList.add('checkbox-group');
  });
  
  // Enhance buttons
  const buttons = document.querySelectorAll('button');
  buttons.forEach(button => {
    if (!button.classList.contains('theme-toggle') && !button.classList.contains('remove-proxy')) {
      let icon = 'fa-plus';
      let btnClass = 'btn-secondary';
      
      if (button.id === 'startScraping') {
        icon = 'fa-play';
        btnClass = 'btn-primary';
        button.innerHTML = `<i class="fas ${icon}"></i> Start Scraping`;
      } else if (button.id === 'stopScraping') {
        icon = 'fa-stop';
        btnClass = 'btn-danger';
        button.innerHTML = `<i class="fas ${icon}"></i> Stop Scraping`;
      } else if (button.id === 'downloadCsv') {
        icon = 'fa-download';
        button.innerHTML = `<i class="fas ${icon}"></i> Download Results (CSV)`;
      } else if (button.id === 'addProxy') {
        button.innerHTML = `<i class="fas ${icon}"></i> Add Another Proxy`;
      }
      
      button.classList.add('btn', btnClass);
    }
  });
  
  // Add font awesome link
  const fontAwesomeLink = document.createElement('link');
  fontAwesomeLink.rel = 'stylesheet';
  fontAwesomeLink.href = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/5.15.4/css/all.min.css';
  document.head.appendChild(fontAwesomeLink);
  
  // Theme toggle functionality
  themeToggle.addEventListener('click', function() {
    document.body.classList.toggle('dark-theme');
    this.innerHTML = document.body.classList.contains('dark-theme') ? 
                    '<i class="fas fa-sun"></i>' : 
                    '<i class="fas fa-moon"></i>';
    
    // Save preference to localStorage
    localStorage.setItem('darkMode', document.body.classList.contains('dark-theme'));
  });
  
  // Check for saved theme preference
  if (localStorage.getItem('darkMode') === 'true') {
    document.body.classList.add('dark-theme');
    themeToggle.innerHTML = '<i class="fas fa-sun"></i>';
  }
  
  // Action Button Layout
  const actionButtons = document.querySelectorAll('#startScraping, #stopScraping');
  const buttonContainer = document.createElement('div');
  buttonContainer.style.display = 'flex';
  buttonContainer.style.gap = '1rem';
  buttonContainer.style.marginBottom = '1.5rem';
  
  actionButtons.forEach(button => {
    buttonContainer.appendChild(button);
  });
  
  // Place button container after URL input
  const urlsTextarea = document.getElementById('urls').closest('.form-group');
  urlsTextarea.after(buttonContainer);
});
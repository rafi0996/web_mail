// Ensure the DOM is fully loaded before attaching event listeners
document.addEventListener("DOMContentLoaded", function () {
  // Get the existing theme toggle button from the HTML
  const themeToggle = document.querySelector(".theme-toggle");

  if (themeToggle) {
    // Theme toggle functionality
    themeToggle.addEventListener("click", function () {
      document.body.classList.toggle("dark-theme");

      // Update icon based on current theme
      this.innerHTML = document.body.classList.contains("dark-theme")
        ? '<i class="fas fa-sun" style="color: yellow;"></i>'
        : '<i class="fas fa-moon"></i>';

      // Save preference to localStorage
      localStorage.setItem(
        "darkMode",
        document.body.classList.contains("dark-theme"),
      );

      console.log(
        "Theme toggled:",
        document.body.classList.contains("dark-theme") ? "dark" : "light",
      );
    });

    // Check for saved theme preference on page load
    if (localStorage.getItem("darkMode") === "true") {
      document.body.classList.add("dark-theme");
      themeToggle.innerHTML = '<i class="fas fa-sun" style="color: yellow;"></i>';
      console.log("Loaded saved dark theme preference");
    }

    console.log("Theme toggle event listener attached successfully");
  } else {
    console.error("Theme toggle button not found in the document");
  }

  // To avoid duplication with the existing code in paste-2.txt, you should
  // either comment out or remove lines 4-9 and 175-187 in that file
});

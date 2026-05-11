from services.amazon_parser import parse_general


def test_parse_general_finds_product_after_boilerplate():
    boilerplate = "\n".join([
        "[![havenframe](https://example.com/logo.png)](https://example.com/)",
        "*   [Home](https://example.com/)",
        "Please enter your e-mail and password:",
        "Email is required",
        "Register Login",
    ] * 90)
    product = """
    [Home](https://www.havenframe.com/)
    [Outdoor Inflatable Cave Waterfall Pool](javascript:;)

    Outdoor Inflatable Cave Waterfall Pool
    $56.99
    $119.99
    - 53%
    Color: blue
    Quantity
    Add to cart
    Buy now
    This outdoor inflatable cave waterfall pool creates a backyard splash zone for kids.
    """

    parsed = parse_general(
        boilerplate + "\n" + product,
        url="https://www.havenframe.com/products/inflatable-cave-waterfall-pool?st=",
    )

    product_data = parsed["product_data"]
    assert product_data["title"] == "Outdoor Inflatable Cave Waterfall Pool"
    assert product_data["price"] == "$56.99"
    assert "Outdoor Inflatable Cave Waterfall Pool" in product_data["bullets"]
    assert "backyard splash zone" in product_data["description"]
    assert "Register Login" not in product_data["bullets"]
